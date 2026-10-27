//! RabbitMQ 拓扑相关的领域模型。
//!
//! 交换机与绑定是 AMQP 独有的概念，因此单独成文件，
//! 不往通用的 `QueueInfo` 上挂可选字段。字段命名与 `src/types/topology.ts` 一致。

use serde::{Deserialize, Serialize};

/// 交换机类型，对应 AMQP 的 `type`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExchangeKind {
    Direct,
    Fanout,
    Topic,
    Headers,
    /// 服务端上报的类型不在已知枚举里时（例如 x-delayed-message）保留原样。
    #[default]
    Unknown,
}

impl ExchangeKind {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "direct" => Self::Direct,
            "fanout" => Self::Fanout,
            "topic" => Self::Topic,
            "headers" => Self::Headers,
            _ => Self::Unknown,
        }
    }
}

/// 交换机信息，对应管理 API `GET /api/exchanges` 的一行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeInfo {
    pub name: String,
    pub vhost: String,
    /// 服务端上报的原始类型字符串，避免前端为未知类型丢失信息。
    pub kind: String,
    /// 交换机类型归类，前端据此决定图标与提示。
    pub exchange_type: ExchangeKind,
    /// 是否为内置交换机（以 `amq.` 开头），这类交换机不可删除。
    pub internal: bool,
    /// 消息进入交换机的速率（每秒）。
    pub message_rate: f64,
}

/// 一条绑定：`source` 交换机按 `routing_key` 把消息路由到 `destination`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingInfo {
    /// 绑定源交换机：`""` 表示默认交换机。
    pub source: String,
    pub destination: String,
    /// 目标类型，`queue` 或 `exchange`。
    pub destination_type: BindingDestination,
    pub routing_key: String,
    /// 绑定参数（headers 交换机用 `x-match` 等），已转成可读字符串。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<crate::domain::KeyValue>,
}

/// 绑定目标类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingDestination {
    Queue,
    Exchange,
}

impl BindingDestination {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "queue" => Some(Self::Queue),
            "exchange" => Some(Self::Exchange),
            _ => None,
        }
    }
}

/// 拓扑概览：交换机、绑定、队列三张表一次返回。
///
/// 管理 API 三个接口是独立的，但页面要同时展示，分开返回会让前端
/// 出现「交换机已刷新、绑定还是旧的」这种半新半旧的中间态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RabbitMqTopology {
    pub exchanges: Vec<ExchangeInfo>,
    pub bindings: Vec<BindingInfo>,
    /// 队列与交换机放在一起返回，拓扑图才能画出完整连线。
    pub queues: Vec<super::QueueInfo>,
}

/// 单条绑定的展示名，用于日志与错误提示。
impl BindingInfo {
    pub fn describe(&self) -> String {
        format!(
            "{} -> {} ({})",
            self.source, self.destination, self.routing_key
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exchange_kind_parses_known_and_unknown() {
        assert_eq!(ExchangeKind::parse("topic"), ExchangeKind::Topic);
        assert_eq!(ExchangeKind::parse("headers"), ExchangeKind::Headers);
        assert_eq!(
            ExchangeKind::parse("x-delayed-message"),
            ExchangeKind::Unknown
        );
    }

    #[test]
    fn exchange_kind_serializes_camel_case() {
        let json = serde_json::to_string(&ExchangeKind::Fanout).expect("序列化失败");
        assert_eq!(json, "\"fanout\"");
    }

    #[test]
    fn binding_destination_rejects_unknown() {
        assert_eq!(
            BindingDestination::parse("queue"),
            Some(BindingDestination::Queue)
        );
        assert_eq!(
            BindingDestination::parse("exchange"),
            Some(BindingDestination::Exchange)
        );
        assert_eq!(BindingDestination::parse("topic"), None);
    }

    #[test]
    fn binding_serializes_camel_case() {
        let binding = BindingInfo {
            source: "orders".to_owned(),
            destination: "orders.queue".to_owned(),
            destination_type: BindingDestination::Queue,
            routing_key: "order.*".to_owned(),
            arguments: Vec::new(),
        };
        let json = serde_json::to_value(&binding).expect("序列化失败");
        assert_eq!(json["destinationType"], "queue");
        // 空参数不出现，前端不必处理空数组分支。
        assert!(json.get("arguments").is_none());
        assert_eq!(binding.describe(), "orders -> orders.queue (order.*)");
    }

    #[test]
    fn topology_serializes_nested_queues() {
        let topology = RabbitMqTopology {
            exchanges: Vec::new(),
            bindings: Vec::new(),
            queues: vec![super::super::QueueInfo {
                name: "orders".to_owned(),
                vhost: "/".to_owned(),
                consumers: 1,
                messages: 3,
            }],
        };
        let json = serde_json::to_value(&topology).expect("序列化失败");
        assert_eq!(json["queues"][0]["messages"], 3);
    }
}

/// 新建交换机请求。
///
/// 只暴露面板真正会用到的字段：`durable` / `auto_delete` 是排查时的常见开关，
/// 其余（`internal`、参数表）交给服务端默认值，避免表单变复杂。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeSpec {
    pub name: String,
    pub kind: String,
    #[serde(default = "default_true")]
    pub durable: bool,
    #[serde(default)]
    pub auto_delete: bool,
}

fn default_true() -> bool {
    true
}

impl ExchangeSpec {
    /// 入参校验。返回的错误可直接展示给用户。
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("交换机名称不能为空".to_owned());
        }
        // `amq.` 前缀是 RabbitMQ 保留命名空间，创建必然被拒，提前拦下更省事。
        if self.name.starts_with("amq.") {
            return Err("`amq.` 前缀为 RabbitMQ 保留命名，不能用于自定义交换机".to_owned());
        }
        ExchangeKind::parse(&self.kind);
        if !matches!(
            self.kind.as_str(),
            "direct" | "fanout" | "topic" | "headers"
        ) {
            return Err(format!(
                "不支持的交换机类型：{}（可选 direct / fanout / topic / headers）",
                self.kind
            ));
        }
        Ok(())
    }
}

/// 队列详情：队列列表只给「有多少」，排查时还要看「是谁在消费」「进出速率」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDetail {
    pub name: String,
    pub vhost: String,
    /// 状态：`running` / `idle` / `flow` 等，服务端原样上报。
    pub state: String,
    pub consumers: u32,
    pub messages: u64,
    pub messages_ready: u64,
    pub messages_unacknowledged: u64,
    /// 入队速率（每秒）。
    pub incoming_rate: f64,
    /// 投递速率（每秒）。
    pub deliver_rate: f64,
    /// 是否持久化队列（非持久化队列重启后消失，删除前值得看一眼）。
    pub durable: bool,
    pub auto_delete: bool,
    /// 队列参数（如 `x-message-ttl`、`x-dead-letter-exchange`），已转成可读字符串。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<crate::domain::KeyValue>,
    /// 绑定的交换机列表，回答「消息从哪来」。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bindings: Vec<BindingInfo>,
}

#[cfg(test)]
mod more_tests {
    use super::*;

    fn spec(name: &str, kind: &str) -> ExchangeSpec {
        ExchangeSpec {
            name: name.to_owned(),
            kind: kind.to_owned(),
            durable: true,
            auto_delete: false,
        }
    }

    #[test]
    fn exchange_spec_rejects_blank_and_reserved_names() {
        assert!(spec("  ", "direct").validate().is_err());
        assert!(spec("amq.direct", "direct").validate().is_err());
        assert!(spec("orders", "").validate().is_err());
        assert!(spec("orders", "x-custom").validate().is_err());
    }

    #[test]
    fn exchange_spec_accepts_known_types() {
        for kind in ["direct", "fanout", "topic", "headers"] {
            assert!(spec("orders", kind).validate().is_ok(), "{kind}");
        }
    }

    #[test]
    fn exchange_spec_defaults_to_durable() {
        let spec: ExchangeSpec =
            serde_json::from_str(r#"{"name":"orders","kind":"topic"}"#).expect("反序列化失败");
        assert!(spec.durable);
        assert!(!spec.auto_delete);
    }

    #[test]
    fn queue_detail_omits_empty_collections() {
        let detail = QueueDetail {
            name: "orders".to_owned(),
            vhost: "/".to_owned(),
            state: "running".to_owned(),
            consumers: 1,
            messages: 2,
            messages_ready: 1,
            messages_unacknowledged: 1,
            incoming_rate: 0.5,
            deliver_rate: 0.25,
            durable: true,
            auto_delete: false,
            arguments: Vec::new(),
            bindings: Vec::new(),
        };
        let json = serde_json::to_value(&detail).expect("序列化失败");
        assert_eq!(json["messagesUnacknowledged"], 1);
        assert!(json.get("arguments").is_none());
        assert!(json.get("bindings").is_none());
    }
}

/// 绑定目标：新建绑定时由用户指定。
///
/// 与 `BindingDestination` 同构，但语义不同——那个是服务端回报的既有绑定目标类型，
/// 这个是「我要绑到哪去」的入参。分开定义可以让入参带上更强的校验。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingTarget {
    pub name: String,
    #[serde(default = "default_queue")]
    pub kind: BindingDestination,
}

fn default_queue() -> BindingDestination {
    BindingDestination::Queue
}

/// 新建绑定请求。
///
/// `source` 允许为空串：AMQP 里默认交换机的名字就是空串，往它上面加绑定
/// 等价于「按队列名直投」，这是很常见的用法。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingSpec {
    pub source: String,
    pub destination: BindingTarget,
    #[serde(default)]
    pub routing_key: String,
    /// 绑定参数（headers 交换机需要 `x-match`），值统一按字符串录入。
    #[serde(default)]
    pub arguments: Vec<crate::domain::KeyValue>,
}

impl BindingSpec {
    /// 入参校验，错误文案可直接展示。
    pub fn validate(&self) -> Result<(), String> {
        if self.destination.name.trim().is_empty() {
            return Err(match self.destination.kind {
                BindingDestination::Queue => "目标队列不能为空".to_owned(),
                BindingDestination::Exchange => "目标交换机不能为空".to_owned(),
            });
        }
        if self.source.trim().is_empty() && self.destination.kind == BindingDestination::Exchange {
            return Err("默认交换机只能绑定到队列，不能绑定交换机".to_owned());
        }
        if self.routing_key.trim().is_empty()
            && self.arguments.is_empty()
            && self.source.trim().is_empty()
        {
            return Err("默认交换机的 routing key 必须填写（通常与队列名相同）".to_owned());
        }
        Ok(())
    }

    /// 转换成 AMQP 绑定参数表。
    ///
    /// 入参值只有字符串一种类型，但 `x-match` 这类参数服务端只看字面量，
    /// 统一按字符串传递与 RabbitMQ 管理界面行为一致。
    pub fn argument_map(&self) -> Vec<(String, String)> {
        self.arguments
            .iter()
            .map(|item| (item.key.clone(), item.value.clone()))
            .collect()
    }
}

/// 删除绑定请求：管理 API 用查询参数定位一条绑定。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingKey {
    pub source: String,
    pub destination: String,
    pub destination_type: BindingDestination,
    #[serde(default)]
    pub routing_key: String,
    /// 绑定参数。headers 交换机上同名 routing key 可以有参数不同的多条绑定，
    /// 不带参数就删不准，因此一并回传。
    #[serde(default)]
    pub arguments: Vec<crate::domain::KeyValue>,
}

impl BindingKey {
    /// 是否指向默认交换机。默认交换机的绑定不允许删除（服务端隐含存在）。
    pub fn is_default_exchange(&self) -> bool {
        self.source.trim().is_empty()
    }
}

/// 交换机删除前的可删性判定。
///
/// 这些规则来自 RabbitMQ 服务端约束，本地先拦一遍可以少一次往返，
/// 也能在界面上给出确切原因而不是「服务端 400」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExchangeRemoval {
    /// 可删除。
    Allowed,
    /// 名称带 `amq.` 前缀的保留交换机。
    Reserved,
    /// 默认交换机（名称为空）由服务端隐式管理，不可删除。
    Default,
    /// 服务端标记为 `internal`，只能由 broker 内部使用。
    Internal,
}

impl ExchangeRemoval {
    /// 按服务端上报的属性判定。
    pub fn evaluate(name: &str, internal: bool) -> Self {
        if name.trim().is_empty() {
            Self::Default
        } else if name.starts_with("amq.") {
            Self::Reserved
        } else if internal {
            Self::Internal
        } else {
            Self::Allowed
        }
    }

    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    /// 不可删除时的原因文案；可删除时返回 `None`。
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::Allowed => None,
            Self::Reserved => Some("`amq.` 前缀是 RabbitMQ 保留交换机，不可删除"),
            Self::Default => Some("默认交换机由服务端隐式提供，不可删除"),
            Self::Internal => Some("内置（internal）交换机不可删除"),
        }
    }
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    use crate::domain::KeyValue;

    fn spec(
        source: &str,
        target: &str,
        kind: BindingDestination,
        routing_key: &str,
    ) -> BindingSpec {
        BindingSpec {
            source: source.to_owned(),
            destination: BindingTarget {
                name: target.to_owned(),
                kind,
            },
            routing_key: routing_key.to_owned(),
            arguments: Vec::new(),
        }
    }

    #[test]
    fn binding_spec_rejects_empty_destination() {
        let error = spec("orders", "  ", BindingDestination::Queue, "k")
            .validate()
            .expect_err("空目标应被拒绝");
        assert!(error.contains("队列"));

        let error = spec("orders", "", BindingDestination::Exchange, "k")
            .validate()
            .expect_err("空目标应被拒绝");
        assert!(error.contains("交换机"));
    }

    #[test]
    fn default_exchange_can_only_bind_queues() {
        assert!(
            spec("", "orders", BindingDestination::Queue, "orders")
                .validate()
                .is_ok()
        );
        assert!(
            spec("", "orders", BindingDestination::Exchange, "orders")
                .validate()
                .is_err()
        );
    }

    #[test]
    fn default_exchange_requires_routing_key() {
        assert!(
            spec("", "orders", BindingDestination::Queue, "")
                .validate()
                .is_err()
        );
    }

    #[test]
    fn headers_binding_accepts_arguments_without_routing_key() {
        let mut binding = spec("events", "audit", BindingDestination::Queue, "");
        binding.arguments = vec![KeyValue::new("x-match", "all")];
        assert!(binding.validate().is_ok());
        assert_eq!(
            binding.argument_map(),
            vec![("x-match".to_owned(), "all".to_owned())]
        );
    }

    #[test]
    fn binding_target_defaults_to_queue() {
        let target: BindingTarget =
            serde_json::from_str(r#"{"name":"orders"}"#).expect("反序列化失败");
        assert_eq!(target.kind, BindingDestination::Queue);
    }

    #[test]
    fn binding_spec_uses_camel_case() {
        let json = serde_json::to_value(spec(
            "orders",
            "orders.q",
            BindingDestination::Queue,
            "order.*",
        ))
        .expect("序列化失败");
        assert_eq!(json["routingKey"], "order.*");
        assert_eq!(json["destination"]["kind"], "queue");
    }

    #[test]
    fn binding_key_flags_default_exchange() {
        let mut key = BindingKey {
            source: String::new(),
            destination: "orders".to_owned(),
            destination_type: BindingDestination::Queue,
            routing_key: "orders".to_owned(),
            arguments: Vec::new(),
        };
        assert!(key.is_default_exchange());
        key.source = "orders".to_owned();
        assert!(!key.is_default_exchange());
    }

    #[test]
    fn exchange_removal_follows_server_constraints() {
        assert_eq!(
            ExchangeRemoval::evaluate("orders", false),
            ExchangeRemoval::Allowed
        );
        assert_eq!(
            ExchangeRemoval::evaluate("", false),
            ExchangeRemoval::Default
        );
        assert_eq!(
            ExchangeRemoval::evaluate("amq.direct", false),
            ExchangeRemoval::Reserved
        );
        // internal 优先于名称判断之外的分支，`amq.` 仍先命中。
        assert_eq!(
            ExchangeRemoval::evaluate("amq.rabbitmq.trace", true),
            ExchangeRemoval::Reserved
        );
        assert_eq!(
            ExchangeRemoval::evaluate("events", true),
            ExchangeRemoval::Internal
        );
    }

    #[test]
    fn exchange_removal_reason_covers_denied_cases() {
        assert!(ExchangeRemoval::Allowed.reason().is_none());
        assert!(ExchangeRemoval::Default.reason().is_some());
        assert!(ExchangeRemoval::Reserved.reason().is_some());
        assert!(ExchangeRemoval::Internal.reason().is_some());
        assert!(ExchangeRemoval::Allowed.is_allowed());
        assert!(!ExchangeRemoval::Internal.is_allowed());
    }
}
