//! RabbitMQ 管理 HTTP API 客户端（管理插件，默认 15672 端口）。
//!
//! AMQP 0-9-1 协议本身没有「枚举队列」「读取队列堆积量」这类接口，
//! 面板要展示这些信息只能走管理插件的 REST API。该能力是可选的：
//! 连接配置里填了管理地址才启用，没填时上层降级为「手动输入队列名」。

use std::time::Duration;

use serde::Deserialize;

use crate::domain::topology::{
    BindingDestination, BindingInfo, BindingKey, BindingSpec, ExchangeInfo, ExchangeKind,
    ExchangeSpec, QueueDetail,
};
use crate::domain::{
    CheckStatus, HealthCheck, KeyValue, QueueInfo, RabbitMqConfig, TlsMode, WRITE_ACCESS_KEY,
};
use crate::error::{AppError, AppResult};

/// 管理 API 的请求超时。面板属于交互式工具，宁可快速失败也不要卡住界面。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// `GET /api/queues` 返回的队列信息，只取面板需要的字段。
#[derive(Debug, Deserialize)]
struct QueuePayload {
    name: String,
    vhost: String,
    #[serde(default)]
    consumers: u32,
    #[serde(default)]
    messages: u64,
}

/// `GET /api/exchanges` 返回的交换机信息。
#[derive(Debug, Deserialize)]
struct ExchangePayload {
    name: String,
    vhost: String,
    #[serde(rename = "type", default = "default_exchange_type")]
    kind: String,
    /// 内置交换机（`amq.*`）不能删除，界面上要标出来。
    #[serde(default)]
    internal: bool,
    /// 管理 API 只给消息速率明细，没有现成的聚合字段。
    #[serde(default)]
    message_stats: Option<MessageStats>,
}

fn default_exchange_type() -> String {
    "unknown".to_owned()
}

#[derive(Debug, Deserialize)]
struct MessageStats {
    #[serde(default, rename = "publish_details")]
    publish: Option<RateDetails>,
}

#[derive(Debug, Deserialize)]
struct RateDetails {
    #[serde(default)]
    rate: f64,
}

/// `GET /api/queues/{vhost}/{name}` 返回的队列详情。
#[derive(Debug, Deserialize)]
struct QueueDetailPayload {
    name: String,
    vhost: String,
    #[serde(default = "default_state")]
    state: String,
    #[serde(default)]
    consumers: u32,
    #[serde(default)]
    messages: u64,
    #[serde(default)]
    messages_ready: u64,
    #[serde(default)]
    messages_unacknowledged: u64,
    #[serde(default)]
    durable: bool,
    #[serde(default)]
    auto_delete: bool,
    #[serde(default)]
    arguments: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    message_stats: Option<QueueStats>,
}

fn default_state() -> String {
    "unknown".to_owned()
}

/// 队列的速率明细，管理 API 分开上报入队与投递两条。
#[derive(Debug, Deserialize)]
struct QueueStats {
    #[serde(default)]
    publish_details: Option<RateDetails>,
    #[serde(default)]
    deliver_get_details: Option<RateDetails>,
}

/// `GET /api/permissions` 返回的一条权限记录。
#[derive(Debug, Deserialize)]
struct PermissionPayload {
    user: String,
    vhost: String,
    #[serde(default)]
    configure: String,
}

/// `GET /api/bindings` 返回的一条绑定。
#[derive(Debug, Deserialize)]
struct BindingPayload {
    source: String,
    destination: String,
    destination_type: String,
    routing_key: String,
    #[serde(default)]
    arguments: serde_json::Map<String, serde_json::Value>,
}

/// 管理 API 客户端。
pub struct ManagementClient {
    /// 管理 API 根地址，例如 `http://localhost:15672`。
    base_url: String,
    http: reqwest::Client,
}

impl ManagementClient {
    /// 按连接配置构造客户端。未配置管理地址时返回 `None`，由调用方降级处理。
    pub fn from_config(config: &RabbitMqConfig) -> AppResult<Option<Self>> {
        let Some(url) = config.management_url.as_deref().map(str::trim) else {
            return Ok(None);
        };
        if url.is_empty() {
            return Ok(None);
        }

        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| AppError::Internal(format!("初始化 HTTP 客户端失败: {error}")))?;

        Ok(Some(Self {
            base_url: url.trim_end_matches('/').to_owned(),
            http,
        }))
    }

    /// 拼接配置里的管理地址，未填写时按 AMQP 主机 + 默认端口推导。
    ///
    /// 推导只是给用户省事：TLS 连接对应 `https` + 15671，否则 `http` + 15672。
    pub fn infer_url(config: &RabbitMqConfig) -> String {
        let (scheme, port) = match config.tls {
            TlsMode::Disabled => ("http", DEFAULT_HTTP_PORT),
            TlsMode::Optional | TlsMode::Required => ("https", DEFAULT_HTTPS_PORT),
        };
        format!("{scheme}://{}:{port}", config.host)
    }

    /// 管理 API 根地址，用于概览页展示。
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 列出全部队列。`vhost` 为 `None` 时查询所有虚拟主机。
    pub async fn queues(&self, config: &RabbitMqConfig) -> AppResult<Vec<QueueInfo>> {
        let payload: Vec<QueuePayload> = self
            .get_json(
                &self.vhost_path("/api/queues", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        Ok(payload
            .into_iter()
            .map(|queue| QueueInfo {
                name: queue.name,
                vhost: queue.vhost,
                consumers: queue.consumers,
                messages: queue.messages,
            })
            .collect())
    }

    /// 列出交换机。
    pub async fn exchanges(&self, config: &RabbitMqConfig) -> AppResult<Vec<ExchangeInfo>> {
        let payload: Vec<ExchangePayload> = self
            .get_json(
                &self.vhost_path("/api/exchanges", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        Ok(payload
            .into_iter()
            .map(|exchange| ExchangeInfo {
                exchange_type: ExchangeKind::parse(&exchange.kind),
                name: exchange.name,
                vhost: exchange.vhost,
                kind: exchange.kind,
                internal: exchange.internal,
                message_rate: exchange
                    .message_stats
                    .and_then(|stats| stats.publish)
                    .map_or(0.0, |details| details.rate),
            })
            .collect())
    }

    /// 列出绑定，并丢弃无法识别目标类型的条目。
    pub async fn bindings(&self, config: &RabbitMqConfig) -> AppResult<Vec<BindingInfo>> {
        let payload: Vec<BindingPayload> = self
            .get_json(
                &self.vhost_path("/api/bindings", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        Ok(payload
            .into_iter()
            .filter_map(|binding| {
                let destination_type = BindingDestination::parse(&binding.destination_type)?;
                Some(BindingInfo {
                    source: binding.source,
                    destination: binding.destination,
                    destination_type,
                    routing_key: binding.routing_key,
                    arguments: binding
                        .arguments
                        .into_iter()
                        .map(|(key, value)| KeyValue::new(key, render_json(&value)))
                        .collect(),
                })
            })
            .collect())
    }

    /// 读取单个队列的详情。
    ///
    /// 走 `/api/queues/{vhost}/{name}` 而不是复用全量列表：详情页只需要一个队列，
    /// 而全量列表在队列上万的集群上代价不可忽略。
    pub async fn queue_detail(
        &self,
        config: &RabbitMqConfig,
        queue: &str,
    ) -> AppResult<QueueDetail> {
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/queues", &config.auth.vhost),
            percent_encode(queue)
        );
        let payload: QueueDetailPayload = self
            .get_json(&path, &config.auth.username, &config.auth.password)
            .await?;

        // 绑定关系在另一个接口里，队列详情页要回答「消息从哪来」只能一并拉全量再筛。
        let bindings = self
            .bindings(config)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|binding| binding.destination == queue)
            .collect();

        Ok(QueueDetail {
            name: payload.name,
            vhost: payload.vhost,
            state: payload.state,
            consumers: payload.consumers,
            messages: payload.messages,
            messages_ready: payload.messages_ready,
            messages_unacknowledged: payload.messages_unacknowledged,
            incoming_rate: payload
                .message_stats
                .as_ref()
                .and_then(|stats| stats.publish_details.as_ref())
                .map_or(0.0, |details| details.rate),
            deliver_rate: payload
                .message_stats
                .as_ref()
                .and_then(|stats| stats.deliver_get_details.as_ref())
                .map_or(0.0, |details| details.rate),
            durable: payload.durable,
            auto_delete: payload.auto_delete,
            arguments: payload
                .arguments
                .into_iter()
                .map(|(key, value)| KeyValue::new(key, render_json(&value)))
                .collect(),
            bindings,
        })
    }

    /// 清空队列（丢弃其中的消息，保留队列本身）。
    pub async fn purge_queue(&self, config: &RabbitMqConfig, queue: &str) -> AppResult<()> {
        let path = format!("{}/contents", self.queue_path(config, queue));
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 删除队列。
    ///
    /// 带 `if-empty=true`：队列里还有消息时服务端返回 400，由调用方转换成
    /// 可读提示。这是刻意的保守设计——误删有消息的队列代价太大。
    pub async fn delete_queue(&self, config: &RabbitMqConfig, queue: &str) -> AppResult<()> {
        let path = format!("{}?if-empty=true", self.queue_path(config, queue));
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 新建交换机。同名的交换机已存在时服务端返回 400，由调用方提示。
    pub async fn create_exchange(
        &self,
        config: &RabbitMqConfig,
        spec: &ExchangeSpec,
    ) -> AppResult<()> {
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/exchanges", &config.auth.vhost),
            percent_encode(&spec.name)
        );
        let body = serde_json::json!({
            "type": spec.kind,
            "durable": spec.durable,
            "auto_delete": spec.auto_delete,
            "internal": false,
            "arguments": {},
        });
        self.put_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// 删除交换机。
    ///
    /// `if_unused=true`：交换机上还挂着绑定时服务端返回 400。和队列删除用 `if-empty`
    /// 是同一个理由——连带把别人正在用的路由打掉，是面板最不该有的一键操作。
    pub async fn delete_exchange(&self, config: &RabbitMqConfig, name: &str) -> AppResult<()> {
        let path = format!("{}?if-unused=true", self.exchange_path(config, name));
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 新建绑定。
    ///
    /// 绑定没有独立的「创建」语义：对已存在的绑定再 PUT 一次是幂等操作，
    /// 但参数不同的同名绑定会让服务端返回 400，错误信息直接透出。
    pub async fn create_binding(
        &self,
        config: &RabbitMqConfig,
        spec: &BindingSpec,
    ) -> AppResult<()> {
        let path = self.binding_path(
            config,
            &spec.source,
            &spec.destination.name,
            spec.destination.kind,
            &spec.routing_key,
            &spec.arguments,
        );
        let arguments: serde_json::Map<String, serde_json::Value> = spec
            .arguments
            .iter()
            .map(|item| {
                (
                    item.key.clone(),
                    serde_json::Value::String(item.value.clone()),
                )
            })
            .collect();
        let body = serde_json::json!({
            "routing_key": spec.routing_key,
            "arguments": arguments,
        });
        self.post_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// 删除绑定。
    ///
    /// 管理 API 用路径定位绑定：`/api/bindings/{vhost}/e/{source}/q|e/{destination}/{routing_key}`
    /// 再追加 `?props=` 传绑定参数。routing key 常带 `*` `#` `.`，必须整体百分号编码，
    /// 否则 `/` 会被当成路径分隔符。
    pub async fn delete_binding(&self, config: &RabbitMqConfig, key: &BindingKey) -> AppResult<()> {
        let path = self.binding_path(
            config,
            &key.source,
            &key.destination,
            key.destination_type,
            &key.routing_key,
            &key.arguments,
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 交换机资源路径。
    fn exchange_path(&self, config: &RabbitMqConfig, name: &str) -> String {
        format!(
            "{}/{}",
            self.vhost_path("/api/exchanges", &config.auth.vhost),
            percent_encode(name)
        )
    }

    /// 绑定资源路径。
    ///
    /// 路径形如 `/api/bindings/{vhost}/e/{source}/q|e/{destination}/{routing_key}`；
    /// 源交换机为空串（默认交换机）时 `e/` 段留空，这是管理 API 的既定格式。
    /// 绑定参数存在时追加 `?props=<JSON>`，服务端用它区分同名但参数不同的绑定。
    fn binding_path(
        &self,
        config: &RabbitMqConfig,
        source: &str,
        destination: &str,
        destination_type: BindingDestination,
        routing_key: &str,
        arguments: &[crate::domain::KeyValue],
    ) -> String {
        let kind = match destination_type {
            BindingDestination::Queue => "q",
            BindingDestination::Exchange => "e",
        };
        let base = format!(
            "{}/e/{}/{}/{}",
            self.vhost_path("/api/bindings", &config.auth.vhost),
            percent_encode(source),
            kind,
            percent_encode(destination),
        );
        // 空 routing key 也要占住最后一段，否则服务端会把它解读成目录。
        let path = format!("{base}/{}", percent_encode(routing_key));

        if arguments.is_empty() {
            return path;
        }
        let props: serde_json::Map<String, serde_json::Value> = arguments
            .iter()
            .map(|item| {
                (
                    item.key.clone(),
                    serde_json::Value::String(item.value.clone()),
                )
            })
            .collect();
        let props = serde_json::Value::Object(props).to_string();
        format!("{path}?props={}", percent_encode(&props))
    }

    /// 探测管理 API 的写权限。
    ///
    /// 不看概览里的 `privileges` 字段——那是「当前用户在该 vhost 的权限」，
    /// 只反映 RabbitMQ 侧的授权，不反映账号是否真的能改配置。
    /// 所以直接查 `/api/permissions`，确认该账号在目标 vhost 上有非空 `configure`。
    /// 查询失败（例如权限受限看不到权限列表）时按「未知」处理，让上层保持按钮可见但提示风险。
    pub async fn write_check(&self, config: &RabbitMqConfig) -> AppResult<HealthCheck> {
        const KEY: &str = WRITE_ACCESS_KEY;
        const LABEL: &str = "管理 API 写权限";

        let payload: Vec<PermissionPayload> = self
            .get_json(
                "/api/permissions",
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        let matched = payload
            .iter()
            .find(|item| item.user == config.auth.username && item.vhost == config.auth.vhost);

        Ok(match matched {
            Some(permission) if !permission.configure.trim().is_empty() => {
                HealthCheck::new(KEY, LABEL, CheckStatus::Ok)
                    .with_detail(format!("configure={}", permission.configure))
            }
            Some(permission) => {
                HealthCheck::new(KEY, LABEL, CheckStatus::Failed).with_detail(format!(
                    "账号 {} 在 vhost {} 没有 configure 权限，无法创建/删除资源",
                    permission.user, permission.vhost
                ))
            }
            None => HealthCheck::new(KEY, LABEL, CheckStatus::Failed).with_detail(format!(
                "管理 API 未上报账号 {} 在 vhost {} 的权限",
                config.auth.username, config.auth.vhost
            )),
        })
    }

    /// 队列资源路径，清空与删除共用。
    fn queue_path(&self, config: &RabbitMqConfig, queue: &str) -> String {
        format!(
            "{}/{}",
            self.vhost_path("/api/queues", &config.auth.vhost),
            percent_encode(queue)
        )
    }

    /// 按连接配置里的 vhost 拼路径，`/`（默认 vhost）走不带 vhost 的裸接口。
    ///
    /// 管理 API 对默认 vhost 同时接受 `/api/queues` 与 `/api/queues/%2F`，
    /// 统一走裸接口可以少一次转义。
    fn vhost_path(&self, base: &str, vhost: &str) -> String {
        match vhost {
            "/" | "" => base.to_owned(),
            vhost => format!("{base}/{}", percent_encode(vhost)),
        }
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        username: &str,
        password: &str,
    ) -> AppResult<T> {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .http
            .get(&url)
            .basic_auth(username, Some(password))
            .send()
            .await
            .map_err(|error| {
                AppError::Broker(format!("RabbitMQ 管理 API 请求失败 ({url}): {error}"))
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Broker(format!(
                "RabbitMQ 管理 API 返回 {status} ({url}): {}",
                body.trim()
            )));
        }

        response
            .json::<T>()
            .await
            .map_err(|error| AppError::Broker(format!("RabbitMQ 管理 API 响应解析失败: {error}")))
    }

    async fn put_json(
        &self,
        path: &str,
        username: &str,
        password: &str,
        body: &serde_json::Value,
    ) -> AppResult<()> {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .http
            .put(&url)
            .basic_auth(username, Some(password))
            .json(body)
            .send()
            .await
            .map_err(|error| {
                AppError::Broker(format!("RabbitMQ 管理 API 请求失败 ({url}): {error}"))
            })?;
        ensure_success(response, &url).await
    }

    async fn post_json(
        &self,
        path: &str,
        username: &str,
        password: &str,
        body: &serde_json::Value,
    ) -> AppResult<()> {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .http
            .post(&url)
            .basic_auth(username, Some(password))
            .json(body)
            .send()
            .await
            .map_err(|error| {
                AppError::Broker(format!("RabbitMQ 管理 API 请求失败 ({url}): {error}"))
            })?;
        ensure_success(response, &url).await
    }

    /// DELETE 有两个语义：清空返回 204，删除返回 204，
    /// 「队列非空」「资源不存在」则返回 4xx，由 `ensure_success` 转成可读错误。
    async fn delete(&self, path: &str, username: &str, password: &str) -> AppResult<()> {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .http
            .delete(&url)
            .basic_auth(username, Some(password))
            .send()
            .await
            .map_err(|error| {
                AppError::Broker(format!("RabbitMQ 管理 API 请求失败 ({url}): {error}"))
            })?;
        ensure_success(response, &url).await
    }
}

/// 把非 2xx 响应转换成可读错误。
///
/// 管理 API 的错误体形如 `{"error":"...","reason":"..."}`，
/// 直接把这句 reason 抛给用户，比一个 HTTP 状态码有用得多。
async fn ensure_success(response: reqwest::Response, url: &str) -> AppResult<()> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }

    let body = response.text().await.unwrap_or_default();
    Err(AppError::Broker(format!(
        "RabbitMQ 管理 API 返回 {status} ({url}): {}",
        error_reason(&body)
    )))
}

/// 从错误体里抽 `reason`，取不到就退回原文。
fn error_reason(body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed)
        && let Some(reason) = value.get("reason").and_then(|item| item.as_str())
    {
        return reason.to_owned();
    }
    trimmed.to_owned()
}

/// 管理 API 的参数值转成展示用字符串：字符串去引号，其余按 JSON 原样。
fn render_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// 管理插件默认的 HTTP / HTTPS 端口。
const DEFAULT_HTTP_PORT: u16 = 15672;
const DEFAULT_HTTPS_PORT: u16 = 15671;

/// 仅保留 RFC 3986 unreserved 字符的百分号编码，用于 vhost 等路径片段。
fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(char::from(byte));
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RabbitMqAuth;

    fn config(tls: TlsMode, management_url: Option<&str>) -> RabbitMqConfig {
        RabbitMqConfig {
            host: "mq.example.com".to_owned(),
            port: 5672,
            tls,
            auth: RabbitMqAuth::default(),
            management_url: management_url.map(str::to_owned),
        }
    }

    #[test]
    fn infer_url_follows_tls_mode() {
        assert_eq!(
            ManagementClient::infer_url(&config(TlsMode::Disabled, None)),
            "http://mq.example.com:15672"
        );
        assert_eq!(
            ManagementClient::infer_url(&config(TlsMode::Required, None)),
            "https://mq.example.com:15671"
        );
    }

    #[test]
    fn empty_management_url_disables_client() {
        assert!(
            ManagementClient::from_config(&config(TlsMode::Disabled, None))
                .expect("构造失败")
                .is_none()
        );
        assert!(
            ManagementClient::from_config(&config(TlsMode::Disabled, Some("  ")))
                .expect("构造失败")
                .is_none()
        );
        assert!(
            ManagementClient::from_config(&config(
                TlsMode::Disabled,
                Some("http://localhost:15672/")
            ))
            .expect("构造失败")
            .is_some()
        );
    }

    #[test]
    fn vhost_is_percent_encoded() {
        assert_eq!(percent_encode("my vhost"), "my%20vhost");
        assert_eq!(percent_encode("/"), "%2F");
    }

    #[test]
    fn default_vhost_uses_bare_path() {
        let client = ManagementClient::from_config(&config(
            TlsMode::Disabled,
            Some("http://localhost:15672"),
        ))
        .expect("构造失败")
        .expect("客户端缺失");
        assert_eq!(client.vhost_path("/api/queues", "/"), "/api/queues");
        assert_eq!(client.vhost_path("/api/queues", ""), "/api/queues");
        assert_eq!(
            client.vhost_path("/api/queues", "my vhost"),
            "/api/queues/my%20vhost"
        );
    }

    #[test]
    fn error_reason_extracts_reason_field() {
        assert_eq!(
            error_reason(r#"{"error":"bad_request","reason":"queue is not empty"}"#),
            "queue is not empty"
        );
        // 非 JSON 的错误体原样返回，至少不丢信息。
        assert_eq!(error_reason("  <html>502</html> "), "<html>502</html>");
        assert_eq!(
            error_reason(r#"{"error":"bad_request"}"#),
            r#"{"error":"bad_request"}"#
        );
    }

    #[test]
    fn queue_and_exchange_paths_are_encoded() {
        let client = ManagementClient::from_config(&config(
            TlsMode::Disabled,
            Some("http://localhost:15672"),
        ))
        .expect("构造失败")
        .expect("客户端缺失");

        // 队列名可能带 `/`，必须转义后再拼进路径。
        assert_eq!(
            client.queue_path(&config(TlsMode::Disabled, None), "a/b"),
            "/api/queues/a%2Fb"
        );
        assert_eq!(
            client.queue_path(&config(TlsMode::Disabled, None), "orders"),
            "/api/queues/orders"
        );
    }

    #[test]
    fn binding_path_locates_binding() {
        let client = ManagementClient::from_config(&config(
            TlsMode::Disabled,
            Some("http://localhost:15672"),
        ))
        .expect("构造失败")
        .expect("客户端缺失");
        let config = config(TlsMode::Disabled, None);

        assert_eq!(
            client.binding_path(
                &config,
                "orders",
                "orders.queue",
                BindingDestination::Queue,
                "order.*",
                &[]
            ),
            "/api/bindings/e/orders/q/orders.queue/order.%2A"
        );

        // 默认交换机的源交换机段为空串，路径里必须保留那个斜杠。
        assert_eq!(
            client.binding_path(
                &config,
                "",
                "orders",
                BindingDestination::Queue,
                "orders",
                &[]
            ),
            "/api/bindings/e//q/orders/orders"
        );

        // routing key 里的 `/` 必须转义，否则会被当成路径分隔符。
        assert_eq!(
            client.binding_path(
                &config,
                "orders",
                "audit",
                BindingDestination::Exchange,
                "a/b",
                &[]
            ),
            "/api/bindings/e/orders/e/audit/a%2Fb"
        );
    }

    #[test]
    fn binding_path_appends_props_for_headers_bindings() {
        let client = ManagementClient::from_config(&config(
            TlsMode::Disabled,
            Some("http://localhost:15672"),
        ))
        .expect("构造失败")
        .expect("客户端缺失");
        let config = config(TlsMode::Disabled, None);
        let arguments = vec![crate::domain::KeyValue::new("x-match", "all")];

        let path = client.binding_path(
            &config,
            "events",
            "audit",
            BindingDestination::Queue,
            "",
            &arguments,
        );
        assert!(path.starts_with("/api/bindings/e/events/q/audit/?props="));
        // props 是 JSON，必须整体编码，否则 `{` `"` 会破坏 URL。
        assert!(!path.contains('{'));
    }

    #[test]
    fn exchange_path_is_encoded() {
        let client = ManagementClient::from_config(&config(
            TlsMode::Disabled,
            Some("http://localhost:15672"),
        ))
        .expect("构造失败")
        .expect("客户端缺失");
        assert_eq!(
            client.exchange_path(&config(TlsMode::Disabled, None), "orders.out"),
            "/api/exchanges/orders.out"
        );
    }

    #[test]
    fn render_json_unquotes_strings() {
        assert_eq!(render_json(&serde_json::json!("all")), "all");
        assert_eq!(render_json(&serde_json::json!(3)), "3");
        assert_eq!(render_json(&serde_json::json!(["a", "b"])), "[\"a\",\"b\"]");
    }
}
