//! RabbitMQ 管理 HTTP API 客户端（管理插件，默认 15672 端口）。
//!
//! AMQP 0-9-1 协议本身没有「枚举队列」「读取队列堆积量」这类接口，
//! 面板要展示这些信息只能走管理插件的 REST API。该能力是可选的：
//! 连接配置里填了管理地址才启用，没填时上层降级为「手动输入队列名」。

use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

use crate::domain::topology::{
    BindingDestination, BindingInfo, BindingKey, BindingSpec, ExchangeInfo, ExchangeKind,
    ExchangeSpec, QueueDetail,
};
use crate::domain::topology_insight::QueueMetrics;
use crate::domain::{
    CheckStatus, ConsumerLinks, DefinitionEntry, HealthCheck, KeyValue, OperatorPolicyInfo,
    ParameterComponent, ParameterError, ParameterInfo, ParameterSnapshot, PermissionInfo,
    PolicyApplyTo, PolicyInfo, PolicySnapshot, PolicySpec, QueueConsumer, QueueInfo,
    RabbitMqConfig, UserInfo, UserSpec, VhostInfo, WRITE_ACCESS_KEY, summarize_consumers,
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
/// `GET /api/queues` 带速率时的队列信息。
///
/// 与 `QueuePayload` 分开定义：路由估算要的是「消息进得来、出得去」的速率，
/// 和队列列表只关心条数是两件事，混在一个结构里会让字段语义含糊。
#[derive(Debug, Deserialize)]
struct QueueMetricsPayload {
    name: String,
    #[serde(default)]
    consumers: u32,
    #[serde(default)]
    messages: u64,
    #[serde(default)]
    message_stats: Option<QueueStats>,
}

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
    #[serde(default)]
    write: String,
    #[serde(default)]
    read: String,
}

impl From<PermissionPayload> for PermissionInfo {
    fn from(payload: PermissionPayload) -> Self {
        Self {
            user: payload.user,
            vhost: payload.vhost,
            configure: payload.configure,
            write: payload.write,
            read: payload.read,
        }
    }
}

/// `GET /api/users` 返回的一个用户。
#[derive(Debug, Deserialize)]
struct UserPayload {
    name: String,
    /// 管理 API 给的是字符串数组，`[]` 表示「不能登管理界面」。
    #[serde(default)]
    tags: Vec<String>,
}

/// `GET /api/vhosts` 返回的一个 vhost。
#[derive(Debug, Deserialize)]
struct VhostPayload {
    name: String,
    #[serde(default)]
    description: String,
    /// 给 shovel / federation 跟踪用的内部 vhost。
    #[serde(default)]
    tracing: bool,
}

/// `/api/vhosts/{name}` 之外的接口回的都是一个对象，但 `tracing` 字段
/// 在老版本里可能缺席，所以这里全给默认值。
impl From<UserPayload> for UserInfo {
    fn from(payload: UserPayload) -> Self {
        Self {
            name: payload.name,
            tags: payload.tags,
        }
    }
}

impl From<VhostPayload> for VhostInfo {
    fn from(payload: VhostPayload) -> Self {
        Self {
            name: payload.name,
            description: payload.description,
            tracing: payload.tracing,
        }
    }
}

/// `GET /api/consumers` 返回的一条消费者记录。
///
/// 管理 API 把每一行摊平成一个消费者，队列名在 `queue.name` 里。
#[derive(Debug, Deserialize)]
struct ConsumerPayload {
    #[serde(default)]
    queue: ConsumerQueueRef,
    #[serde(default)]
    consumer_tag: String,
    #[serde(default)]
    channel_details: Option<ConsumerChannel>,
    #[serde(default)]
    ack_required: bool,
    #[serde(default)]
    prefetch_count: u32,
    #[serde(default)]
    messages_unacknowledged: u64,
}

#[derive(Debug, Default, Deserialize)]
struct ConsumerQueueRef {
    #[serde(default)]
    name: String,
}

/// 消费者所属的连接与 channel。老版本管理 API 只给 `channel` 字符串，全字段可选。
#[derive(Debug, Deserialize)]
struct ConsumerChannel {
    #[serde(default)]
    connection_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    user: Option<String>,
}

/// `GET /api/connections` 里归属视图需要的几列。
///
/// 与 `runtime.rs` 的 `ConnPayload` 分开：那个服务于运行时页（要速率），
/// 这里只要「谁、从哪来、是不是阻塞」—— 多拉字段在连接上百时是白花的解析开销。
#[derive(Debug, Deserialize)]
struct OwnershipConnectionPayload {
    name: String,
    #[serde(default)]
    client_properties: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    peer_host: String,
    #[serde(default)]
    peer_port: u16,
    #[serde(default)]
    state: String,
}

/// `GET /api/channels` 里归属视图需要的几列。
#[derive(Debug, Deserialize)]
struct OwnershipChannelPayload {
    name: String,
    #[serde(default)]
    connection_details: Option<OwnershipConnRef>,
    #[serde(default)]
    user: String,
}

#[derive(Debug, Deserialize)]
struct OwnershipConnRef {
    #[serde(default)]
    name: String,
}

/// `GET /api/queues` 里消费者连线需要的三列。
///
/// 与 `QueuePayload` 分开：那个服务于队列列表，这里只要「待投递 / 未确认」这两个数，
/// 多拉字段在队列上万的集群上是白花的解析开销。
#[derive(Debug, Deserialize)]
struct QueueConsumptionPayload {
    name: String,
    #[serde(default)]
    messages_ready: u64,
    #[serde(default)]
    messages_unacknowledged: u64,
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
/// `GET /api/policies[/{vhost}]` 返回的策略。
#[derive(Debug, Deserialize)]
struct PolicyPayload {
    name: String,
    vhost: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    priority: i32,
    #[serde(rename = "apply-to", default = "default_apply_to")]
    apply_to: String,
    #[serde(default)]
    definition: serde_json::Map<String, serde_json::Value>,
}

/// 操作员策略的响应结构。和普通策略同形，但语义不同，因此单独定义。
#[derive(Debug, Deserialize)]
struct OperatorPolicyPayload {
    name: String,
    vhost: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    priority: i32,
    #[serde(rename = "apply-to", default = "default_apply_to")]
    apply_to: String,
    #[serde(default)]
    definition: serde_json::Map<String, serde_json::Value>,
}

fn default_apply_to() -> String {
    "all".to_owned()
}

/// `GET /api/parameters/{component}[/{vhost}]` 返回的参数。
///
/// `value` 保持原始 JSON：federation / shovel / runtime 三类结构完全不同，
/// 本地建成强类型等于给每个版本都挖一个坑。
#[derive(Debug, Deserialize)]
struct ParameterPayload {
    #[serde(default)]
    component: String,
    #[serde(default)]
    vhost: String,
    name: String,
    #[serde(default)]
    value: serde_json::Value,
}

impl From<ParameterPayload> for ParameterInfo {
    fn from(payload: ParameterPayload) -> Self {
        Self {
            component: payload.component,
            vhost: payload.vhost,
            name: payload.name,
            value: payload.value,
        }
    }
}

/// `GET /api/shovels` 的一行。
///
/// 这个接口由 shovel 插件提供：插件没启用时返回 **404**，而不是空数组。
/// 两者差别很大 —— 前者是「看不到」，后者才是「一条都没有」，上层要分开处理。
#[derive(Debug, Deserialize)]
struct ShovelPayload {
    name: String,
    #[serde(default)]
    vhost: String,
    #[serde(default)]
    state: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    src_uri: Option<String>,
    #[serde(default)]
    dest_uri: Option<String>,
    #[serde(default)]
    src_queue: Option<String>,
    #[serde(default)]
    dest_queue: Option<String>,
    #[serde(default)]
    info: Option<ShovelInfo>,
    /// 累计搬运条数。不同版本放的位置不一样（顶层 / `info` 内），两处都认。
    #[serde(default)]
    messages_transferred: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ShovelInfo {
    #[serde(default)]
    src_uri: Option<String>,
    #[serde(default)]
    dest_uri: Option<String>,
    #[serde(default)]
    messages_transferred: Option<u64>,
}

impl ShovelPayload {
    /// 解析一行运行态。单独成函数是为了能单测：`info` 嵌套与顶层字段的
    /// 取值顺序、空 vhost 归一、认不出来的状态，都只在这一处判。
    /// 状态字段统一转成三态。**未知取值判 `Terminated` 而不是猜成运行中**：
    /// 把一条认不出来的状态当成「在搬」，比报错更容易误导人 —— 消息其实可能一点没动。
    fn state(&self) -> crate::domain::ShovelState {
        match self.state.trim() {
            "running" => crate::domain::ShovelState::Running,
            "starting" => crate::domain::ShovelState::Starting,
            _ => crate::domain::ShovelState::Terminated,
        }
    }

    fn into_runtime(self) -> crate::domain::ShovelRuntime {
        // 顶层字段在部分版本上缺失，真实的连接信息在 `info` 里；`src` / `dest`
        // 两处取值顺序无所谓，但**顶层优先**：那是它此刻在连的东西。
        let state = self.state();
        let info = self.info.as_ref();
        let src_uri = self
            .src_uri
            .or_else(|| info.and_then(|item| item.src_uri.clone()))
            .or(self.src_queue)
            .unwrap_or_default();
        let dest_uri = self
            .dest_uri
            .or_else(|| info.and_then(|item| item.dest_uri.clone()))
            .or(self.dest_queue)
            .unwrap_or_default();
        crate::domain::ShovelRuntime {
            name: self.name,
            vhost: if self.vhost.trim().is_empty() {
                "/".to_owned()
            } else {
                self.vhost
            },
            state,
            kind: if self.kind.trim().is_empty() {
                "static".to_owned()
            } else {
                self.kind
            },
            reason: self.reason,
            src_uri,
            dest_uri,
            // 搬运条数只有运行态给得出，配置里没有这个字段。
            messages_transferred: self
                .messages_transferred
                .or_else(|| info.and_then(|item| item.messages_transferred))
                .unwrap_or(0),
        }
    }
}

pub struct ManagementClient {
    /// 管理 API 根地址，例如 `http://localhost:15672`。
    base_url: String,
    http: reqwest::Client,
}

impl ManagementClient {
    /// 按连接配置构造客户端。
    ///
    /// 地址取自 `RabbitMqConfig::resolved_management_url`：填了用填的，空着按
    /// host + TLS 推一个。所以这里只有「显式关掉」（配置里写空串）才返回 `None`
    /// —— 管理 API 是队列、交换机、绑定、策略的共同底座，不该因为少填一格就整片灰掉。
    pub fn from_config(config: &RabbitMqConfig) -> AppResult<Option<Self>> {
        let Some(url) = config.resolved_management_url() else {
            return Ok(None);
        };

        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| AppError::Internal(format!("初始化 HTTP 客户端失败: {error}")))?;

        Ok(Some(Self {
            base_url: url,
            http,
        }))
    }

    /// 按 AMQP 主机 + 默认端口推导的管理地址。规则在领域层，这里只转发一次，
    /// 免得调用处各自记一遍 15672 / 15671。
    pub fn infer_url(config: &RabbitMqConfig) -> String {
        config.inferred_management_url()
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

    /// 队列的进出速率。
    ///
    /// 只取路由估算需要的三个数字：投递速率、入队速率、消费者数。
    /// 与 `queues()` 复用同一个接口，但用途不同，因此单独成型而不是给 `QueueInfo` 加字段——
    /// 队列列表页不需要速率，多拉两列不会有人感激。
    pub async fn queue_metrics(&self, config: &RabbitMqConfig) -> AppResult<Vec<QueueMetrics>> {
        let payload: Vec<QueueMetricsPayload> = self
            .get_json(
                &self.vhost_path("/api/queues", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        Ok(payload
            .into_iter()
            .map(|queue| QueueMetrics {
                name: queue.name,
                messages: queue.messages,
                consumers: queue.consumers,
                incoming_rate: queue
                    .message_stats
                    .as_ref()
                    .and_then(|stats| stats.publish_details.as_ref())
                    .map_or(0.0, |details| details.rate),
                deliver_rate: queue
                    .message_stats
                    .as_ref()
                    .and_then(|stats| stats.deliver_get_details.as_ref())
                    .map_or(0.0, |details| details.rate),
            })
            .collect())
    }

    /// 每个 vhost 的队列数：`GET /api/queues` 按 `vhost` 归并。
    ///
    /// 与 `queue_metrics()` 分开：那边算路由要速率明细，这里只要条数，
    /// 而且必须带 `vhost` 字段（`queue_metrics` 的载荷结构里没有它）。
    pub async fn queue_counts(&self, config: &RabbitMqConfig) -> AppResult<Vec<(String, usize)>> {
        let payload: Vec<QueuePayload> = self
            .get_json("/api/queues", &config.auth.username, &config.auth.password)
            .await?;

        let mut counts: Vec<(String, usize)> = Vec::new();
        for queue in payload {
            match counts.iter_mut().find(|(name, _)| name == &queue.vhost) {
                Some((_, count)) => *count += 1,
                None => counts.push((queue.vhost, 1)),
            }
        }
        Ok(counts)
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

    /// 拉取消费者连线：队列侧堆积量 + 全部消费者。
    ///
    /// 队列与消费者是两次请求：`/api/consumers` 不会带上「没人消费的队列」，
    /// 而「这个队列零消费者」恰恰是排查时最想看到的结论，所以必须从队列侧补齐。
    pub async fn consumer_links(&self, config: &RabbitMqConfig) -> AppResult<ConsumerLinks> {
        let queues: Vec<QueueConsumptionPayload> = self
            .get_json(
                &self.vhost_path("/api/queues", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        // 消费者列表在权限受限的账号上可能返回 403；此时仍然给出「哪些队列没人消费」
        // 这个结论——它比整个页面报错有用得多。
        let consumers = self.consumers(config).await.unwrap_or_default();

        let queue_rows: Vec<(String, u64, u64)> = queues
            .into_iter()
            .map(|queue| {
                (
                    queue.name,
                    queue.messages_ready,
                    queue.messages_unacknowledged,
                )
            })
            .collect();

        Ok(summarize_consumers(&queue_rows, &consumers))
    }

    /// 队列级消费者归属：把消费者挂回「哪条连接、哪个账号、哪个对端地址」。
    ///
    /// 四次请求各自可能失败，含义完全不同，所以降级策略也不一样：
    ///
    /// - 队列拉不到 → 整页没意义，直接 `Err`（连「哪些队列没人消费」都答不了）；
    /// - 消费者拉不到 → 权限不足时是 403，此时仍然给出「哪些队列没人消费」这个结论；
    /// - 连接 / channel 拉不到 → 只是少了「哪台机器」这一栏，归属本身仍然成立。
    ///
    /// 三次请求串行：管理插件对并发很敏感，交互式面板多花几十毫秒换服务端轻松些。
    pub async fn consumer_ownership(
        &self,
        config: &RabbitMqConfig,
    ) -> AppResult<crate::domain::OwnershipSnapshot> {
        use crate::domain::{ChannelFacts, ConnectionFacts, assemble_ownership};

        use super::runtime::client_name;

        let queues: Vec<QueueConsumptionPayload> = self
            .get_json(
                &self.vhost_path("/api/queues", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        let consumers = self.consumers(config).await.unwrap_or_default();

        let connection_payload: Vec<OwnershipConnectionPayload> = self
            .get_json(
                &self.vhost_path("/api/connections", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await
            .unwrap_or_default();
        let channel_payload: Vec<OwnershipChannelPayload> = self
            .get_json(
                &self.vhost_path("/api/channels", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await
            .unwrap_or_default();

        let queue_rows: Vec<(String, u64, u64)> = queues
            .into_iter()
            .map(|queue| {
                (
                    queue.name,
                    queue.messages_ready,
                    queue.messages_unacknowledged,
                )
            })
            .collect();

        let connections: Vec<ConnectionFacts> = connection_payload
            .into_iter()
            .map(|row| {
                let client_name = client_name(&row.client_properties);
                ConnectionFacts {
                    peer: if row.peer_host.is_empty() {
                        String::new()
                    } else {
                        format!("{}:{}", row.peer_host, row.peer_port)
                    },
                    blocked: matches!(row.state.as_str(), "blocking" | "blocked"),
                    name: row.name,
                    client_name,
                    user: row.user,
                }
            })
            .collect();
        let channels: Vec<ChannelFacts> = channel_payload
            .into_iter()
            .map(|row| ChannelFacts {
                name: row.name,
                connection: row.connection_details.map_or_else(String::new, |d| d.name),
                user: row.user,
            })
            .collect();

        Ok(assemble_ownership(
            &queue_rows,
            &consumers,
            &connections,
            &channels,
        ))
    }

    /// 拉取全部消费者明细（`GET /api/consumers`）。
    pub async fn consumers(&self, config: &RabbitMqConfig) -> AppResult<Vec<QueueConsumer>> {
        let payload: Vec<ConsumerPayload> = self
            .get_json(
                &self.vhost_path("/api/consumers", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        Ok(payload
            .into_iter()
            .map(|item| {
                let channel = item.channel_details;
                QueueConsumer {
                    queue: item.queue.name,
                    consumer_tag: item.consumer_tag,
                    connection_name: channel
                        .as_ref()
                        .and_then(|details| details.connection_name.clone())
                        .filter(|name| !name.is_empty()),
                    channel: channel.as_ref().and_then(|details| details.name.clone()),
                    username: channel.and_then(|details| details.user).unwrap_or_default(),
                    ack_required: item.ack_required,
                    prefetch_count: item.prefetch_count,
                    messages_unacknowledged: item.messages_unacknowledged,
                }
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

    /// 断开一个消费者（`DELETE /api/consumers/{vhost}/{consumer_tag}`）。
    ///
    /// 这是 AMQP 里唯一可行的入口：协议层的 `basic.cancel` 只能由持有该 channel 的
    /// 客户端发出，面板作为第三方连接没法替对端取消消费。管理 API 的做法是直接关闭
    /// 该 consumer 所在的 channel，对端会收到 channel 关闭错误。
    ///
    /// 正因为它「替别人动手」，安全判定全部放在调用方（`domain::consumer_disconnect`），
    /// 这里只负责发请求并把服务端的 `reason` 透出来。
    pub async fn disconnect_consumer(
        &self,
        config: &RabbitMqConfig,
        consumer_tag: &str,
    ) -> AppResult<()> {
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/consumers", &config.auth.vhost),
            percent_encode(consumer_tag)
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 拉取策略快照：普通策略 + 操作员策略。
    ///
    /// 两者分两次请求：操作员策略接口在老版本 RabbitMQ 上不存在（3.8 之前），
    /// 拉不到时只记录 `operator_error`，不影响普通策略的展示。
    pub async fn policies(&self, config: &RabbitMqConfig) -> AppResult<PolicySnapshot> {
        let payload: Vec<PolicyPayload> = self
            .get_json(
                &self.vhost_path("/api/policies", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        let policies = payload.into_iter().map(PolicyInfo::from).collect();

        // 操作员策略是可选信息，失败时降级为「无」并把原因带回去。
        let (operator_policies, operator_error) = match self.operator_policies(config).await {
            Ok(list) => (list, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };

        Ok(PolicySnapshot {
            policies,
            operator_policies,
            operator_error,
        })
    }

    /// 操作员策略列表。接口不存在或权限不足时返回错误，由 `policies` 降级处理。
    pub async fn operator_policies(
        &self,
        config: &RabbitMqConfig,
    ) -> AppResult<Vec<OperatorPolicyInfo>> {
        let payload: Vec<OperatorPolicyPayload> = self
            .get_json(
                &self.vhost_path("/api/operator-policies", &config.auth.vhost),
                &config.auth.username,
                &config.auth.password,
            )
            .await?;

        Ok(payload.into_iter().map(OperatorPolicyInfo::from).collect())
    }

    /// 新建或修改策略。
    ///
    /// 管理 API 用 PUT 做幂等写：同名策略已存在时是「替换」，不存在时是「新建」。
    /// 这一点值得在界面上说清楚——「保存」在不存在的名字上等于新建，
    /// 而拼错一个名字会静默多出一条策略，原策略继续生效。
    pub async fn put_policy(
        &self,
        config: &RabbitMqConfig,
        spec: &PolicySpec,
        name: &str,
    ) -> AppResult<()> {
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/policies", &config.auth.vhost),
            percent_encode(name)
        );
        let body = policy_body(spec);
        self.put_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// 删除策略。策略删除只是停止下发，不会动已有消息，因此不带任何守卫参数。
    pub async fn delete_policy(&self, config: &RabbitMqConfig, name: &str) -> AppResult<()> {
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/policies", &config.auth.vhost),
            percent_encode(name)
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 拉取参数快照：逐个组件拉，某一类失败只影响它自己。
    ///
    /// 不一次拉 `/api/parameters` 全量：三类的读权限常常不同（`runtime` 通常只有管理员能看），
    /// 全量接口一处 401 就整页空掉，而用户其实只想看联邦。
    pub async fn parameters(&self, config: &RabbitMqConfig) -> AppResult<ParameterSnapshot> {
        let mut parameters = Vec::new();
        let mut errors = Vec::new();

        for component in ParameterComponent::ALL {
            match self
                .parameters_of(config, component, &config.auth.vhost)
                .await
            {
                Ok(list) => parameters.extend(list),
                Err(error) => errors.push(ParameterError {
                    component: component.component().to_owned(),
                    message: error.to_string(),
                }),
            }
        }

        // 老版本管理 API 不认识 `{component}` 段，第一个组件就会失败；
        // 这时界面上要说清「不是没配，是这个版本不支持」，而不是展示一堆红字。
        let component_filter_supported = errors.len() < ParameterComponent::ALL.len();

        Ok(ParameterSnapshot {
            parameters,
            errors,
            component_filter_supported,
        })
    }

    /// 读取铲子的运行态（`GET /api/shovels`，不带 vhost 段即全部 vhost）。
    ///
    /// 这个接口属于 shovel 插件：插件没启用时是 404，权限不足是 401/403。
    /// 两种情况都不是「一条铲子都没有」，所以返回 `Err` 让上层去说清原因；
    /// 返回空数组才表示「确实没有」。
    pub async fn shovels(
        &self,
        config: &RabbitMqConfig,
    ) -> AppResult<Vec<crate::domain::ShovelRuntime>> {
        let payload: Vec<ShovelPayload> = self
            .get_json("/api/shovels", &config.auth.username, &config.auth.password)
            .await?;
        Ok(payload
            .into_iter()
            .map(ShovelPayload::into_runtime)
            .collect())
    }

    /// 铲子运行态与配置的合并快照。
    ///
    /// 两个接口各自会失败，且失败的含义不同：参数拉不到等于「没有配置」，
    /// 运行态拉不到等于「看不到」——后者不能把每条铲子都写成「无运行态」。
    pub async fn shovel_snapshot(
        &self,
        config: &RabbitMqConfig,
    ) -> AppResult<crate::domain::ShovelSnapshot> {
        let parameters = self
            .parameters_of(config, ParameterComponent::Shovel, &config.auth.vhost)
            .await?;
        let (runtimes, runtime_error) = match self.shovels(config).await {
            Ok(list) => (list, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        Ok(crate::domain::assemble_shovels(
            &parameters,
            &runtimes,
            &config.auth.vhost,
            runtime_error,
        ))
    }

    /// 某一类组件在某个 vhost 下的参数列表。
    pub async fn parameters_of(
        &self,
        config: &RabbitMqConfig,
        component: ParameterComponent,
        vhost: &str,
    ) -> AppResult<Vec<ParameterInfo>> {
        let base = self.vhost_path(&format!("/api/parameters/{}", component.component()), vhost);
        let payload: Vec<ParameterPayload> = self
            .get_json(&base, &config.auth.username, &config.auth.password)
            .await?;
        Ok(payload.into_iter().map(ParameterInfo::from).collect())
    }

    /// 新建或修改参数。管理 API 用 PUT 做幂等写：同名即替换。
    pub async fn put_parameter(
        &self,
        config: &RabbitMqConfig,
        component: ParameterComponent,
        vhost: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> AppResult<()> {
        let path = format!(
            "{}/{}",
            self.parameter_base(component, vhost),
            percent_encode(name)
        );
        self.put_json(&path, &config.auth.username, &config.auth.password, value)
            .await
    }

    /// 删除参数。
    pub async fn delete_parameter(
        &self,
        config: &RabbitMqConfig,
        component: ParameterComponent,
        vhost: &str,
        name: &str,
    ) -> AppResult<()> {
        let path = format!(
            "{}/{}",
            self.parameter_base(component, vhost),
            percent_encode(name)
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 参数集合路径：`/api/parameters/{component}/{vhost}`。
    ///
    /// `runtime` 参数的 vhost 段必须是 `/`——服务端对这一点是强制的，
    /// 传业务 vhost 会 404，而不是「静默忽略」。
    fn parameter_base(&self, component: ParameterComponent, vhost: &str) -> String {
        let vhost = match component.vhost_scope() {
            crate::domain::VhostScope::DefaultOnly => "/",
            crate::domain::VhostScope::PerVhost => vhost,
        };
        self.vhost_path(&format!("/api/parameters/{}", component.component()), vhost)
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

    /// 全部 vhost（`GET /api/vhosts`）。
    ///
    /// 这是本文件里唯一不需要 vhost 段的资源：vhost 是别的资源的容器，
    /// 它自己永远挂在根上。
    pub async fn vhosts(&self, config: &RabbitMqConfig) -> AppResult<Vec<VhostInfo>> {
        let payload: Vec<VhostPayload> = self
            .get_json("/api/vhosts", &config.auth.username, &config.auth.password)
            .await?;
        Ok(payload.into_iter().map(VhostInfo::from).collect())
    }

    /// 新建 vhost。
    ///
    /// 管理 API 用 PUT：已存在时是「改描述」，不存在时是「新建」。
    /// 这个语义要在界面上说清楚，否则「新建」一个同名 vhost 会静默变成改描述。
    pub async fn put_vhost(
        &self,
        config: &RabbitMqConfig,
        name: &str,
        description: &str,
    ) -> AppResult<()> {
        let path = format!("/api/vhosts/{}", percent_encode(name));
        let body = serde_json::json!({ "description": description });
        self.put_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// 删除 vhost。
    ///
    /// 管理 API **没有** `if-empty` 这类守卫参数：一个 DELETE 下去，里面的队列、
    /// 消息、权限、策略一起消失。所以「该不该拦」全部在 `domain::admin` 判，
    /// 这里只负责发请求并把服务端的话原样透出来。
    pub async fn delete_vhost(&self, config: &RabbitMqConfig, name: &str) -> AppResult<()> {
        let path = format!("/api/vhosts/{}", percent_encode(name));
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 全部用户（`GET /api/users`）。
    ///
    /// 响应里**不含密码哈希**（管理 API 从不返回它），这也是这里敢直接展示的原因。
    pub async fn users(&self, config: &RabbitMqConfig) -> AppResult<Vec<UserInfo>> {
        let payload: Vec<UserPayload> = self
            .get_json("/api/users", &config.auth.username, &config.auth.password)
            .await?;
        Ok(payload.into_iter().map(UserInfo::from).collect())
    }

    /// 新建或修改用户。
    ///
    /// `password_hash` 只接受 RabbitMQ 自己的哈希格式（`base64(salt + sha256)`），
    /// 传明文会被当成哈希存下来 —— 于是账号「建好了」，但谁也登不上。
    /// 所以这里只走 `password`，把哈希拼接留在调用侧（`broker::rabbitmq::admin`）。
    ///
    /// `tags` 为空数组时是「不能登管理界面」，不是「默认权限」。
    pub async fn put_user(
        &self,
        config: &RabbitMqConfig,
        spec: &UserSpec,
        password_hash: Option<&str>,
    ) -> AppResult<()> {
        let path = format!("/api/users/{}", percent_encode(spec.name.trim()));
        let mut body = serde_json::json!({
            "tags": spec.tags,
        });
        if let Some(hash) = password_hash {
            body["password_hash"] = serde_json::Value::String(hash.to_owned());
        }
        self.put_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// 删除用户。连带删除该用户在所有 vhost 上的权限。
    pub async fn delete_user(&self, config: &RabbitMqConfig, name: &str) -> AppResult<()> {
        let path = format!("/api/users/{}", percent_encode(name));
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 全部权限（`GET /api/permissions`，不按 vhost 过滤）。
    ///
    /// 权限页要看的是「谁在哪些 vhost 上有什么」，按当前连接的 vhost 过滤只会
    /// 藏起另一半答案。受限账号上这个接口可能 403，由调用方降级。
    pub async fn permissions(&self, config: &RabbitMqConfig) -> AppResult<Vec<PermissionInfo>> {
        let payload: Vec<PermissionPayload> = self
            .get_json(
                "/api/permissions",
                &config.auth.username,
                &config.auth.password,
            )
            .await?;
        Ok(payload.into_iter().map(PermissionInfo::from).collect())
    }

    /// 给某个用户在某个 vhost 上授权。
    ///
    /// 三段正则是**覆盖**语义，不是合并：没写的那段会被置空，等于「什么都不许」。
    /// 所以编辑权限时必须把三段一起提交，界面上也不能只让人改其中一段。
    pub async fn put_permission(
        &self,
        config: &RabbitMqConfig,
        user: &str,
        vhost: &str,
        configure: &str,
        write: &str,
        read: &str,
    ) -> AppResult<()> {
        let path = format!(
            "/api/permissions/{}/{}",
            percent_encode(vhost),
            percent_encode(user)
        );
        let body = serde_json::json!({
            "configure": configure,
            "write": write,
            "read": read,
        });
        self.put_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// 撤销某个用户在某个 vhost 上的全部权限。
    ///
    /// 这是「停止访问」而不是「限制访问」：撤销之后该用户在这个 vhost 上
    /// 什么都做不了，包括读自己已有的消息。
    pub async fn delete_permission(
        &self,
        config: &RabbitMqConfig,
        user: &str,
        vhost: &str,
    ) -> AppResult<()> {
        let path = format!(
            "/api/permissions/{}/{}",
            percent_encode(vhost),
            percent_encode(user)
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
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
    pub(super) fn vhost_path(&self, base: &str, vhost: &str) -> String {
        match vhost {
            "/" | "" => base.to_owned(),
            vhost => format!("{base}/{}", percent_encode(vhost)),
        }
    }

    pub(super) async fn get_json<T: for<'de> Deserialize<'de>>(
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

    /// 投递一条消息到队列。
    ///
    /// 这条路径只给批量处置用：批量时消息已经在手上（从队列里取出来的原文 + properties），
    /// 走 AMQP 重发一遍反而要开新通道、重新拼装 properties。
    /// 走 HTTP 则可以把原文与 properties 原样递给服务端，由服务端负责路由。
    pub async fn publish_to_queue(
        &self,
        config: &RabbitMqConfig,
        queue: &str,
        payload: &[u8],
        properties: &serde_json::Value,
    ) -> AppResult<()> {
        let path = format!("{}/publish", self.queue_path(config, queue));
        let body = publish_body(queue, payload, properties);
        self.post_json(&path, &config.auth.username, &config.auth.password, &body)
            .await
    }

    /// DELETE 有两个语义：清空返回 204，删除返回 204，
    /// 「队列非空」「资源不存在」则返回 4xx，由 `ensure_success` 转成可读错误。
    pub(super) async fn delete(&self, path: &str, username: &str, password: &str) -> AppResult<()> {
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

/// 拼管理 API 的 `publish` 请求体。
///
/// 关键在于 `payload_encoding`：`string` 表示 payload 是原文字符串，
/// 服务端按 UTF-8 重新编码成字节 —— 二进制消息（图片、protobuf、压缩块）
/// 经过 `from_utf8_lossy` 之后，每个非法字节都变成 U+FFFD，
/// 投递「成功」了，可到的是一条彻底损坏的消息，而且没有任何一处会报错。
///
/// 所以判定要按「能不能无歧义地往返」来，而不是「看着像不像文本」：
/// 只要是合法 UTF-8 就走 `string`（服务端收到再编码回来，字节不变），
/// 否则一律 `base64` —— 那是管理 API 唯一能无损表达任意字节的方式。
fn publish_body(queue: &str, payload: &[u8], properties: &serde_json::Value) -> serde_json::Value {
    let (encoded, encoding) = match std::str::from_utf8(payload) {
        Ok(text) => (text.to_owned(), "string"),
        Err(_) => (
            base64::engine::general_purpose::STANDARD.encode(payload),
            "base64",
        ),
    };

    serde_json::json!({
        "properties": properties,
        "routing_key": queue,
        "payload": encoded,
        "payload_encoding": encoding,
    })
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

impl From<PolicyPayload> for PolicyInfo {
    fn from(payload: PolicyPayload) -> Self {
        Self {
            name: payload.name,
            vhost: payload.vhost,
            pattern: payload.pattern,
            priority: payload.priority,
            apply_to: parse_apply_to(&payload.apply_to),
            definition: definition_entries(payload.definition),
        }
    }
}

impl From<OperatorPolicyPayload> for OperatorPolicyInfo {
    fn from(payload: OperatorPolicyPayload) -> Self {
        Self {
            name: payload.name,
            vhost: payload.vhost,
            pattern: payload.pattern,
            priority: payload.priority,
            apply_to: parse_apply_to(&payload.apply_to),
            definition: definition_entries(payload.definition),
        }
    }
}

/// 未知的 `apply-to` 值按「全部」处理：宁可少生效也不要让界面上一个策略消失。
fn parse_apply_to(raw: &str) -> PolicyApplyTo {
    PolicyApplyTo::parse(raw).unwrap_or(PolicyApplyTo::All)
}

/// 把 `definition` 的 JSON 值渲染成可编辑的字符串。
///
/// 数组（例如 `ha-params: ["a@host"]`）按 JSON 原样展示——它是合法的可回填格式，
/// 转成逗号串再还原会把「一个元素的数组」和「一个字符串」搞混。
fn definition_entries(
    definition: serde_json::Map<String, serde_json::Value>,
) -> Vec<DefinitionEntry> {
    definition
        .into_iter()
        .map(|(key, value)| DefinitionEntry {
            key,
            value: render_json(&value),
        })
        .collect()
}

/// 把领域层的定义项还原成管理 API 认识的 JSON。
///
/// 已知的整型 / 布尔键要还原成真正的数字与布尔——服务端对 `x-message-ttl: "60000"`
/// 这种字符串会直接 400。其余键保持字符串。
fn policy_body(spec: &PolicySpec) -> serde_json::Value {
    let mut definition = serde_json::Map::new();
    for entry in &spec.definition {
        definition.insert(entry.key.clone(), typed_value(&entry.key, &entry.value));
    }

    serde_json::json!({
        "pattern": spec.pattern,
        "priority": spec.priority,
        "apply-to": spec.apply_to.as_str(),
        "definition": definition,
    })
}

/// 按 `definition_value_kind` 把字符串值转成 JSON 类型。
fn typed_value(key: &str, raw: &str) -> serde_json::Value {
    let value = raw.trim();
    if matches!(
        key,
        "x-max-priority"
            | "max-priority"
            | "x-message-ttl"
            | "x-expires"
            | "x-max-length"
            | "x-delivery-limit"
            | "message-ttl"
            | "expires"
            | "max-length"
            | "delivery-limit"
    ) && let Ok(number) = value.parse::<i64>()
    {
        return serde_json::Value::from(number);
    }

    if matches!(key, "x-single-active-consumer" | "x-queue-master-locator")
        && let Ok(flag) = value.parse::<bool>()
    {
        return serde_json::Value::from(flag);
    }

    // 已经是 JSON 的结构（数组 / 对象）原样回填，例如镜像的 `ha-params`。
    if (value.starts_with('[') || value.starts_with('{'))
        && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(value)
    {
        return parsed;
    }

    serde_json::Value::String(value.to_owned())
}

/// 仅保留 RFC 3986 unreserved 字符的百分号编码，用于 vhost 等路径片段。
pub(super) fn percent_encode(raw: &str) -> String {
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
    use crate::domain::{RabbitMqAuth, TlsMode};

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
    fn missing_management_url_falls_back_to_inferred_one() {
        // 空着 = 按 host 推一个。管理 API 是队列 / 交换机 / 策略的共同底座，
        // 少填一格不该让整片能力消失。
        let client = ManagementClient::from_config(&config(TlsMode::Disabled, None))
            .expect("构造失败")
            .expect("客户端缺失");
        assert_eq!(client.base_url(), "http://mq.example.com:15672");
    }

    #[test]
    fn explicit_empty_management_url_disables_client() {
        // 空串是「我就是不想用管理插件」，与没填区分开。
        assert!(
            ManagementClient::from_config(&config(TlsMode::Disabled, Some("  ")))
                .expect("构造失败")
                .is_none()
        );
    }

    #[test]
    fn trailing_slash_is_trimmed() {
        let client = ManagementClient::from_config(&config(
            TlsMode::Disabled,
            Some("http://localhost:15672/"),
        ))
        .expect("构造失败")
        .expect("客户端缺失");
        assert_eq!(client.base_url(), "http://localhost:15672");
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

    fn client() -> ManagementClient {
        ManagementClient::from_config(&config(TlsMode::Disabled, Some("http://localhost:15672")))
            .expect("构造失败")
            .expect("客户端缺失")
    }

    #[test]
    fn policy_body_types_known_keys() {
        let spec = PolicySpec {
            name: "ttl".to_owned(),
            pattern: "orders.*".to_owned(),
            priority: 3,
            apply_to: PolicyApplyTo::Queues,
            definition: vec![
                DefinitionEntry {
                    key: "x-message-ttl".to_owned(),
                    value: "60000".to_owned(),
                },
                DefinitionEntry {
                    key: "x-single-active-consumer".to_owned(),
                    value: "true".to_owned(),
                },
                // 未知键保持字符串：插件自己能识别。
                DefinitionEntry {
                    key: "x-custom".to_owned(),
                    value: "abc".to_owned(),
                },
            ],
        };

        let body = policy_body(&spec);
        assert_eq!(body["apply-to"], "queues");
        assert_eq!(body["priority"], 3);
        // 整数必须发成数字，服务端对字符串形式会 400。
        assert_eq!(body["definition"]["x-message-ttl"], 60000);
        assert_eq!(body["definition"]["x-single-active-consumer"], true);
        assert_eq!(body["definition"]["x-custom"], "abc");
    }

    #[test]
    fn policy_body_keeps_json_structures() {
        // 镜像的 ha-params 是数组，原样回填；转成逗号串再还原会改变语义。
        let spec = PolicySpec {
            name: "ha".to_owned(),
            pattern: ".*".to_owned(),
            priority: 0,
            apply_to: PolicyApplyTo::All,
            definition: vec![DefinitionEntry {
                key: "ha-params".to_owned(),
                value: r#"["rabbit@node1"]"#.to_owned(),
            }],
        };
        assert_eq!(
            policy_body(&spec)["definition"]["ha-params"],
            serde_json::json!(["rabbit@node1"])
        );
    }

    #[test]
    fn policy_definition_round_trips_through_entries() {
        let mut definition = serde_json::Map::new();
        definition.insert("x-max-length".to_owned(), serde_json::json!(100));
        definition.insert("alternate-exchange".to_owned(), serde_json::json!("ae"));

        let entries = definition_entries(definition);
        // 顺序取决于 Map 实现，按 key 找而不是按下标断言。
        let find = |key: &str| {
            entries
                .iter()
                .find(|entry| entry.key == key)
                .map(|entry| entry.value.clone())
                .expect("缺少定义项")
        };
        assert_eq!(find("x-max-length"), "100");
        // 字符串值去引号，直接可编辑。
        assert_eq!(find("alternate-exchange"), "ae");
    }

    #[test]
    fn unknown_apply_to_falls_back_to_all() {
        // 让策略从界面上消失比「范围判错」更难排查，因此兜底到 all。
        assert_eq!(parse_apply_to("queues"), PolicyApplyTo::Queues);
        assert_eq!(parse_apply_to("nodes"), PolicyApplyTo::All);
    }

    #[test]
    fn policy_paths_are_encoded() {
        let client = client();
        assert_eq!(client.vhost_path("/api/policies", "/"), "/api/policies");
        assert_eq!(
            client.vhost_path("/api/policies", "team a"),
            "/api/policies/team%20a"
        );
        // 策略名可能带空格，拼进路径前必须转义。
        assert_eq!(percent_encode("ha all"), "ha%20all");
    }

    #[test]
    fn publish_body_keeps_text_as_string() {
        let body = publish_body("orders", "中文".as_bytes(), &serde_json::json!({}));
        assert_eq!(body["payload_encoding"], "string");
        assert_eq!(body["routing_key"], "orders");
        assert_eq!(body["payload"], "中文");
    }

    #[test]
    fn publish_body_encodes_binary_as_base64() {
        // 关键回归：这几段字节过不了 UTF-8。按 `string` 走会被 `from_utf8_lossy`
        // 换成 U+FFFD，投递「成功」但消息已经彻底损坏，而且没有任何一处会报错。
        let payload = [0xff_u8, 0xfe, 0x00, 0x80];
        let body = publish_body(
            "blobs",
            &payload,
            &serde_json::json!({"content_type": "image/png"}),
        );
        assert_eq!(body["payload_encoding"], "base64");
        let encoded = body["payload"].as_str().expect("payload 应是字符串");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("base64 解不开"),
            payload
        );
        // properties 原样透传，不能因为改了 payload 编码就丢掉。
        assert_eq!(body["properties"]["content_type"], "image/png");
    }

    #[test]
    fn publish_body_keeps_empty_payload_as_string() {
        // 空消息在 RabbitMQ 里是合法的（纯信号）。空字节同时是合法 UTF-8，
        // 因此走 `string` 且 payload 为空串，而不是 base64 的 `""` 语义模糊。
        let body = publish_body("signals", &[], &serde_json::json!({}));
        assert_eq!(body["payload_encoding"], "string");
        assert_eq!(body["payload"], "");
    }

    #[test]
    fn shovel_payload_reads_top_level_fields() {
        let payload: ShovelPayload = serde_json::from_value(serde_json::json!({
            "name": "sh1",
            "vhost": "orders",
            "state": "running",
            "type": "static",
            "src_uri": "amqp://u:p@a:5672",
            "dest_uri": "amqp://u:p@b:5672",
            "messages_transferred": 7
        }))
        .expect("应能解析");
        let runtime = payload.into_runtime();
        assert_eq!(runtime.vhost, "orders");
        assert_eq!(runtime.state, crate::domain::ShovelState::Running);
        assert_eq!(runtime.messages_transferred, 7);
        assert_eq!(runtime.src_uri, "amqp://u:p@a:5672");
    }

    #[test]
    fn shovel_payload_falls_back_to_info_block() {
        // 部分版本把地址与条数放在 `info` 里；顶层缺失时要能捡回来，
        // 否则界面上会出现一条「在运行、但不知道搬什么」的铲子。
        let payload: ShovelPayload = serde_json::from_value(serde_json::json!({
            "name": "sh2",
            "state": "terminated",
            "reason": "boom",
            "info": {
                "src_uri": "amqp://x:1",
                "dest_uri": "amqp://y:1",
                "messages_transferred": 123
            }
        }))
        .expect("应能解析");
        let runtime = payload.into_runtime();
        // vhost 缺失时归一成默认 vhost，不能留空串。
        assert_eq!(runtime.vhost, "/");
        assert_eq!(runtime.dest_uri, "amqp://y:1");
        assert_eq!(runtime.messages_transferred, 123);
        assert_eq!(runtime.state, crate::domain::ShovelState::Terminated);
    }

    #[test]
    fn unknown_shovel_state_is_not_optimistic() {
        // 认不出来的状态不能猜成「在跑」：消息可能一点没动。
        let payload: ShovelPayload = serde_json::from_value(serde_json::json!({
            "name": "sh3",
            "state": "weird"
        }))
        .expect("应能解析");
        assert_eq!(
            payload.into_runtime().state,
            crate::domain::ShovelState::Terminated
        );
    }

    #[test]
    fn render_json_unquotes_strings() {
        assert_eq!(render_json(&serde_json::json!("all")), "all");
        assert_eq!(render_json(&serde_json::json!(3)), "3");
        assert_eq!(render_json(&serde_json::json!(["a", "b"])), "[\"a\",\"b\"]");
    }
}
