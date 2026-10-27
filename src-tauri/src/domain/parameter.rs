//! RabbitMQ 参数（parameter）：federation / shovel / runtime 三类。
//!
//! 参数和策略是两条线。策略是「对资源生效的规则」，参数是「组件自己的运行配置」：
//! - `federation`：联邦上游（从别的 broker 拉消息）与联邦策略；
//! - `shovel`：铲子，把消息从一个地址搬到另一个地址，可以跨 broker；
//! - `runtime`：节点级参数，典型的是 `cluster_name`。
//!
//! 这三类共用同一个 REST 接口 `PUT /api/parameters/{component}/{vhost}/{name}`，
//! 但**语义差别很大**，所以这一层的主要工作是「别让人把三类混着用」：
//!
//! 1. 组件的 `vhost` 语义不同：`runtime` 参数必须放在默认 vhost `/` 下，
//!    放到业务 vhost 里服务端不报错，但永远不会生效；
//! 2. `value` 是自由 JSON，一个字段拼错的代价是「参数能保存、连接一直不通」，
//!    服务端不会替你校验；
//! 3. 有的组件真的会拨号出去（federation / shovel），删掉或改错会影响到
//!    正在搬运的消息，需要提前说清后果。
//!
//! 规则全收成纯函数，不碰网络，可单测。前端对应 `src/lib/parameter.ts`。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 参数组件类型。取值就是管理 API 路径里的 `{component}` 段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParameterComponent {
    FederationUpstream,
    FederationPolicy,
    Shovel,
    Runtime,
}

impl ParameterComponent {
    pub const ALL: [Self; 4] = [
        Self::FederationUpstream,
        Self::FederationPolicy,
        Self::Shovel,
        Self::Runtime,
    ];

    /// 管理 API 路径里的组件名（federation-upstream 这种带连字符，不是驼峰）。
    pub const fn component(self) -> &'static str {
        match self {
            Self::FederationUpstream => "federation-upstream",
            Self::FederationPolicy => "federation-upstream-set",
            Self::Shovel => "shovel",
            Self::Runtime => "runtime",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|item| item.component() == raw.trim())
    }

    /// 中文名，界面直接用。
    pub const fn label(self) -> &'static str {
        match self {
            Self::FederationUpstream => "联邦上游",
            Self::FederationPolicy => "联邦上游集",
            Self::Shovel => "铲子",
            Self::Runtime => "运行时参数",
        }
    }

    /// 这一类的 `vhost` 语义。
    ///
    /// 只有 `runtime` 是「必须放在默认 vhost」，其余两类跟着业务 vhost 走。
    pub const fn vhost_scope(self) -> VhostScope {
        match self {
            Self::FederationUpstream | Self::FederationPolicy | Self::Shovel => {
                VhostScope::PerVhost
            }
            Self::Runtime => VhostScope::DefaultOnly,
        }
    }

    /// 这类参数会不会主动拨号出去。
    ///
    /// 会拨号的那些（联邦、铲子）改错或删掉的后果是「消息停止搬运」，
    /// 而消息本身还在源端堆积——不看界面根本发现不了。
    pub const fn dials_out(self) -> bool {
        matches!(
            self,
            Self::FederationUpstream | Self::FederationPolicy | Self::Shovel
        )
    }
}

/// 参数属于哪个 vhost。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VhostScope {
    /// 每个 vhost 一套，互不影响。
    PerVhost,
    /// 只认默认 vhost `/`，放在别处等于没配。
    DefaultOnly,
}

/// 一条参数（管理 API 的 `GET /api/parameters[/{component}[/{vhost}]]`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterInfo {
    /// 组件名（原始值，例如 `federation-upstream`）。
    pub component: String,
    pub vhost: String,
    pub name: String,
    /// 参数值。保留原始 JSON：不同组件的结构差别很大，本地建模等于自找麻烦。
    pub value: Value,
}

impl ParameterInfo {
    /// 解析出组件枚举。未知组件（插件注册的）返回 `None`，界面按「其它」展示。
    pub fn kind(&self) -> Option<ParameterComponent> {
        ParameterComponent::parse(&self.component)
    }

    /// 列表里的一行摘要：只取这个组件最要紧的一两个字段。
    ///
    /// 值全部是自由 JSON，直接把整个对象塞进表格没法看。这里只挑出
    /// 「出问题时第一个要看的那个字段」，其余留在详情里。
    pub fn summary(&self) -> String {
        let Some(kind) = self.kind() else {
            return compact_json(&self.value, 60);
        };
        let pick = |key: &str| {
            self.value
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };

        let parts: Vec<String> = match kind {
            // 「从哪拉」是排查联邦的第一句话。
            ParameterComponent::FederationUpstream => [
                pick("uri").map(|uri| format!("uri={}", redact_uri(&uri))),
                self.value
                    .get("prefetch-count")
                    .map(|count| format!("prefetch={count}")),
            ]
            .into_iter()
            .flatten()
            .collect(),
            // 上游集本身只是个列表，真正有用的是它引用了几个上游。
            ParameterComponent::FederationPolicy => self
                .value
                .get("value")
                .and_then(Value::as_array)
                .map(|items| vec![format!("{} 个联邦上游", items.len())])
                .unwrap_or_default(),
            // 铲子的源与目标是它的全部定义。
            ParameterComponent::Shovel => [
                pick("src-uri").map(|uri| format!("src={}", redact_uri(&uri))),
                pick("dest-uri").map(|uri| format!("dest={}", redact_uri(&uri))),
            ]
            .into_iter()
            .flatten()
            .collect(),
            // 运行时参数几乎只有 `cluster_name`，值本身就是一句话。
            ParameterComponent::Runtime => self
                .value
                .as_str()
                .map(|text| vec![text.to_owned()])
                .unwrap_or_default(),
        };

        if parts.is_empty() {
            compact_json(&self.value, 60)
        } else {
            parts.join(" · ")
        }
    }
}

/// URI 里的口令打码。
///
/// 联邦和铲子的 URI 常写成 `amqp://user:pass@host:5672/vhost`，
/// 直接铺在列表里等于把密码印在屏幕上——截个图发给同事就漏了。
/// 口令里常常带 `@`（生成的随机密码尤其如此），所以切分 userinfo 有两条讲究：
///
/// 1. 只在 **authority 段**里找 `@`。`amqp://user:pass@host:5672/v@x` 的路径里
///    也有 `@`，全局 `rsplit_once` 会把主机切成 `x`，把口令原样留在屏幕上；
/// 2. authority 段内取**最后一个** `@`，这是 RFC 3986 的做法：口令里未转义的
///    `@` 只能靠「从右往左第一个」和主机分隔开。
///
/// 两条以前都踩了：`rsplit_once('@')` 同时违反这两点，于是
/// `user:p@ss@host` 会变成「用户 user / 口令 p@ss 的主机叫 host」——
/// 打码结果里照样能看到口令。
pub fn redact_uri(uri: &str) -> String {
    let Some((scheme, rest)) = uri.split_once("://") else {
        return uri.to_owned();
    };
    // authority 到路径 / query / fragment 为止。
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let Some(at) = authority.rfind('@') else {
        return uri.to_owned();
    };

    let userinfo = &authority[..at];
    let host = &rest[at + 1..];
    let masked = match userinfo.find(':') {
        Some(colon) => format!("{}:***", &userinfo[..colon]),
        // 只有用户名没有口令，原样保留。
        None => return uri.to_owned(),
    };
    format!("{scheme}://{masked}@{host}")
}

/// 把任意 JSON 压成一行摘要，超长截断。
fn compact_json(value: &Value, max: usize) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        text
    } else {
        format!("{}…", chars[..max].iter().collect::<String>())
    }
}

/// 新建 / 修改参数的请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterSpec {
    pub component: ParameterComponent,
    pub vhost: String,
    pub name: String,
    /// 提交的原始 JSON 文本。留着文本而不是解析后的值，
    /// 是为了在「JSON 语法错」时能把用户输入原样还回去，不至于清空重写。
    pub value: String,
}

/// 校验结果：错误（阻断）与提醒（可继续）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterReview {
    /// 阻断性问题。非空时不允许提交。
    pub errors: Vec<String>,
    /// 不阻断但必须让用户看到的后果。
    pub caveats: Vec<String>,
    /// 解析成功时的值，供命令层直接提交。
    #[serde(skip)]
    pub value: Option<Value>,
}

impl ParameterReview {
    pub fn is_blocking(&self) -> bool {
        !self.errors.is_empty()
    }
}

/// 参数的本地校验。
///
/// 这里刻意不做字段级白名单：federation / shovel 的参数在版本之间加过字段，
/// 本地拦下来只会挡住合法用法。真正会拦的只有三类——
/// 「服务端必然拒绝」「保存成功但永远不生效」「大概率抄错了地址」。
pub fn review(spec: &ParameterSpec) -> ParameterReview {
    let mut review = ParameterReview::default();

    let name = spec.name.trim();
    if name.is_empty() {
        review.errors.push("参数名称不能为空".to_owned());
    } else if name != spec.name {
        review.errors.push("参数名称首尾不能有空白字符".to_owned());
    }

    // `runtime` 参数的 vhost 必须是默认 vhost：放到业务 vhost 下服务端照收，
    // 但节点级参数只在 `/` 读取，等于配了个永不生效的东西。
    if spec.component.vhost_scope() == VhostScope::DefaultOnly
        && !matches!(spec.vhost.trim(), "/" | "")
    {
        review.errors.push(format!(
            "`{}` 是节点级参数，只能放在默认 vhost `/` 下；放在 `{}` 里不会生效",
            spec.component.component(),
            spec.vhost
        ));
    }

    let parsed = match serde_json::from_str::<Value>(spec.value.trim()) {
        Ok(value) => Some(value),
        Err(error) => {
            review.errors.push(format!("参数值不是合法 JSON：{error}"));
            None
        }
    };

    if let Some(value) = parsed.clone() {
        review.errors.extend(shape_errors(spec.component, &value));
        review.caveats.extend(caveats(spec.component, &value));
    }

    review.value = parsed.filter(|_| review.errors.is_empty());
    review
}

/// 组件对值形状的要求。服务端多数时候也会拒，但报错是一句
/// 「{error,{...}}」级别的 Erlang 术语，界面提前说清更省事。
fn shape_errors(component: ParameterComponent, value: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    match component {
        ParameterComponent::FederationUpstream | ParameterComponent::Shovel => {
            // 两者都必须给地址，否则这个参数没有任何意义。
            let key = if component == ParameterComponent::Shovel {
                "src-uri"
            } else {
                "uri"
            };
            if value.get(key).is_none() {
                errors.push(format!(
                    "`{}` 必须包含 `{key}`：没有地址就无从连接",
                    component.component()
                ));
            }
            if component == ParameterComponent::Shovel && value.get("dest-uri").is_none() {
                errors.push("`shovel` 必须包含 `dest-uri`：铲子要把消息搬去哪里".to_owned());
            }
        }
        ParameterComponent::FederationPolicy => {
            if !value.is_object() || value.get("value").is_none_or(|inner| !inner.is_array()) {
                errors.push(
                    "`federation-upstream-set` 的形状固定为 `{\"value\": [{...}, ...]}`".to_owned(),
                );
            }
        }
        // 运行时参数的值多数是字符串（`cluster_name`），也允许对象。
        ParameterComponent::Runtime => {
            if !value.is_string() && !value.is_object() {
                errors.push("`runtime` 参数的值应为字符串或对象".to_owned());
            }
        }
    }
    errors
}

/// 提交前必须让用户看到的后果。
fn caveats(component: ParameterComponent, value: &Value) -> Vec<String> {
    let mut notes = Vec::new();

    // 地址里带口令：提醒一句它会被明文存进 broker 的 definitions 导出。
    let uris: Vec<&str> = ["uri", "src-uri", "dest-uri"]
        .iter()
        .filter_map(|key| value.get(*key).and_then(Value::as_str))
        .collect();
    if uris.iter().any(|uri| redact_uri(uri) != *uri) {
        notes.push(
            "地址里带了口令：参数会原样存进 broker，导出 definitions 时也会被带出去".to_owned(),
        );
    }

    if component.dials_out() {
        notes.push(
            "这类参数会让节点主动拨号出去；改错或删除的后果是「消息停止搬运」，而源端的消息仍在堆积"
                .to_owned(),
        );
    }

    if component == ParameterComponent::Shovel {
        notes.push(
            "铲子属于「搬走即删除」：`dest-uri` 写错到另一个 vhost 时，消息会被搬到你不想放的地方"
                .to_owned(),
        );
    }

    notes
}

/// 删除前的判定与后果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterRemoval {
    pub allowed: bool,
    /// 确认框里要写的话。删除参数不像删队列那么危险，但它会静默停掉搬运。
    pub detail: String,
}

impl ParameterRemoval {
    pub fn evaluate(component: ParameterComponent, name: &str) -> Self {
        if name.trim().is_empty() {
            return Self {
                allowed: false,
                detail: "参数名称为空，无法定位".to_owned(),
            };
        }
        let detail = match component {
            ParameterComponent::Runtime => {
                "运行时参数删除后立刻失效，相关节点行为会退回默认值".to_owned()
            }
            _ => {
                "删除后这条联邦 / 铲子会停止工作，但已搬运的消息不受影响；源端会继续堆积".to_owned()
            }
        };
        Self {
            allowed: true,
            detail,
        }
    }
}

/// 参数页的整体快照。
///
/// 分组件拉取：`runtime` 与其它三类常常需要不同的权限，某一类没权限时
/// 只该让那一块空着，不该整页报错。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterSnapshot {
    pub parameters: Vec<ParameterInfo>,
    /// 按组件记录的拉取失败原因（键是组件名）。
    pub errors: Vec<ParameterError>,
    /// 管理 API 版本是否带 `component` 过滤。老版本不支持，界面要说明。
    pub component_filter_supported: bool,
}

/// 某一类组件拉取失败。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterError {
    pub component: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(component: ParameterComponent, vhost: &str, value: &str) -> ParameterSpec {
        ParameterSpec {
            component,
            vhost: vhost.to_owned(),
            name: "p".to_owned(),
            value: value.to_owned(),
        }
    }

    #[test]
    fn component_names_round_trip() {
        for component in ParameterComponent::ALL {
            assert_eq!(
                ParameterComponent::parse(component.component()),
                Some(component)
            );
            assert!(!component.label().is_empty());
        }
        assert_eq!(
            ParameterComponent::parse("federation-upstream-set"),
            Some(ParameterComponent::FederationPolicy)
        );
        assert_eq!(ParameterComponent::parse("nope"), None);
    }

    #[test]
    fn runtime_parameter_must_live_in_default_vhost() {
        let wrong_vhost = review(&spec(
            ParameterComponent::Runtime,
            "orders",
            r#""orders-cluster""#,
        ));
        assert!(wrong_vhost.is_blocking());
        assert!(wrong_vhost.errors[0].contains("默认 vhost"));

        // 默认 vhost 下放行；空串等同默认 vhost。
        assert!(!review(&spec(ParameterComponent::Runtime, "/", "\"c\"")).is_blocking());
        assert!(!review(&spec(ParameterComponent::Runtime, "", "\"c\"")).is_blocking());
    }

    #[test]
    fn invalid_json_blocks_submission() {
        let review = review(&spec(
            ParameterComponent::FederationUpstream,
            "/",
            "{\"uri\": }",
        ));
        assert!(review.is_blocking());
        assert!(review.errors[0].contains("JSON"));
        assert!(review.value.is_none());
    }

    #[test]
    fn upstream_requires_uri_and_shovel_requires_both_ends() {
        let missing_uri = review(&spec(ParameterComponent::FederationUpstream, "/", "{}"));
        assert!(missing_uri.errors[0].contains("uri"));

        let shovel = review(&spec(
            ParameterComponent::Shovel,
            "/",
            r#"{"src-uri":"amqp://a"}"#,
        ));
        assert!(shovel.errors[0].contains("dest-uri"));
    }

    #[test]
    fn upstream_set_shape_is_enforced() {
        let broken = review(&spec(
            ParameterComponent::FederationPolicy,
            "/",
            r#"{"a":1}"#,
        ));
        assert!(broken.is_blocking());

        let ok = review(&spec(
            ParameterComponent::FederationPolicy,
            "/",
            r#"{"value":[{"upstream":"a"}]}"#,
        ));
        assert!(!ok.is_blocking());
    }

    #[test]
    fn credentials_in_uri_are_flagged() {
        let review = review(&spec(
            ParameterComponent::FederationUpstream,
            "/",
            r#"{"uri":"amqp://user:secret@remote:5672"}"#,
        ));
        assert!(!review.is_blocking());
        assert!(review.caveats.iter().any(|note| note.contains("口令")));
        // 提醒说明了导出 definitions 也会带出去这件事。
        assert!(
            review
                .caveats
                .iter()
                .any(|note| note.contains("definitions"))
        );
    }

    #[test]
    fn summary_masks_password() {
        let info = ParameterInfo {
            component: "federation-upstream".to_owned(),
            vhost: "/".to_owned(),
            name: "up".to_owned(),
            value: serde_json::json!({
                "uri": "amqp://guest:guest@remote:5672",
                "prefetch-count": 100,
            }),
        };
        let summary = info.summary();
        assert!(!summary.contains("guest:guest"), "实际摘要：{summary}");
        assert!(summary.contains("prefetch=100"), "实际摘要：{summary}");
    }

    #[test]
    fn redact_uri_handles_missing_userinfo() {
        assert_eq!(
            redact_uri("amqp://user:pass@host:5672/v"),
            "amqp://user:***@host:5672/v"
        );
        // 没有口令时原样返回，不当成需要打码。
        assert_eq!(redact_uri("amqp://host:5672"), "amqp://host:5672");
        assert_eq!(redact_uri("not a uri"), "not a uri");
    }

    #[test]
    fn redact_uri_keeps_password_out_of_sight() {
        // 回归：口令里带 `@`（生成的随机密码很常见）时，按最后一个 `@` 切
        // 会把主机当成口令，于是整段 `user:pa%40ss` 原样留在屏幕上。
        let cases = [
            "amqp://user:p%40ss@host:5672/v",
            "amqp://user:p@ss@host:5672/v",
            // 路径里带 `@`：不能被当成 userinfo 的分界。
            "amqp://user:pass@host:5672/v@x",
        ];
        for uri in cases {
            let redacted = redact_uri(uri);
            assert!(redacted.contains("user:***@"), "实际：{redacted}");
            assert!(!redacted.contains("pass"), "口令没打码：{redacted}");
            assert!(!redacted.contains("p@ss"), "口令没打码：{redacted}");
        }
        assert_eq!(
            redact_uri("amqp://user:p@ss@host:5672/v"),
            "amqp://user:***@host:5672/v"
        );
        assert_eq!(
            redact_uri("amqps://user:pass@host/vhost?heartbeat=30"),
            "amqps://user:***@host/vhost?heartbeat=30"
        );
    }

    #[test]
    fn removal_blocks_blank_name_only() {
        assert!(!ParameterRemoval::evaluate(ParameterComponent::Shovel, " ").allowed);
        let verdict = ParameterRemoval::evaluate(ParameterComponent::Shovel, "sh");
        assert!(verdict.allowed);
        assert!(verdict.detail.contains("停止工作"));
    }

    #[test]
    fn only_federation_and_shovel_dial_out() {
        assert!(ParameterComponent::FederationUpstream.dials_out());
        assert!(ParameterComponent::Shovel.dials_out());
        assert!(!ParameterComponent::Runtime.dials_out());
    }
}
