//! 消息相关的领域模型。

use serde::{Deserialize, Serialize};

use crate::domain::BrokerKind;

/// 消息列表查询条件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
    pub connection_id: String,
    /// Kafka 对应 topic，RabbitMQ 对应 queue。
    pub target: String,
    /// 最多返回条数，后端会做上限裁剪。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 上一页返回的游标，前端原样回传表示「加载更多」；缺省表示从头读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 只看某个分区（仅 Kafka）。
    ///
    /// 排查「这个分区是不是热点 / 落后」时，多分区混在一起的列表根本读不出来。
    /// 只影响**首次读取**的起点，续读仍由游标决定 —— 否则翻到一半改条件会前后矛盾。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition: Option<i32>,
}

/// 列表中的消息摘要，只包含渲染列表必需的信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    /// 消息在列表中的稳定标识，用于拉取详情。
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partition: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    /// 毫秒时间戳，缺失时由前端显示 `-`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// 截断后的内容预览，详情接口返回完整内容。
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<usize>,
    /// 完整 payload（UTF-8 最佳努力解码）。仅 RabbitMQ 填充。
    ///
    /// AMQP 的 deliveryTag 在 `basic.reject(requeue = true)` 之后会被重新分配，
    /// 列表里的 ID 事后回源查不到，因此消息内容只能随列表一起下发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
}

/// 消息详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub summary: MessageSummary,
    /// 原始 payload，已按 UTF-8 最佳努力解码；二进制内容以 base64 附带。
    pub payload: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_base64: Option<String>,
    /// 消息 key 的原始字节（base64），**只在 key 不是合法 UTF-8 时给**。
    ///
    /// 文本 key 用 `summary.key` 就够了；二进制 key 只看文本会被读成 `\u{fffd}`，
    /// 重发就换了分区。空着表示「照文本发就对了」，不用来回多传一份。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_base64: Option<String>,
    pub headers: Vec<MessageHeader>,
}

/// 消息头键值。
///
/// `value` 为 `None` 表示「这个 header 在消息里存在，但没有值」。
/// 空串不能兼任这个意思：发送预览按 AMQP 的 `longstr` 建字段表，
/// 空值以 `void` 发出，而 `void` 与空串在 headers 交换机上匹配结果完全不同
/// （空串能匹配 `key = ""` 的绑定参数，`void` 一条都匹配不上）。
/// 列表里显示成空串，但结论要按「没有值」算。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHeader {
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

impl MessageHeader {
    /// 带值的 header。
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: Some(value.into()),
        }
    }

    /// 展示用文本：没有值时是空串。
    pub fn value_text(&self) -> &str {
        self.value.as_deref().unwrap_or("")
    }
}

/// 一个 header 的**原始**字节值，以及它的文本形式。
///
/// `MessageHeader` 只装得下文本，够展示不够重发：Avro / Protobuf 消息的 header
/// 可能是任意字节，`String::from_utf8_lossy` 一过就再也回不到原样；
/// 而 `value: None` 是「有这个 header 但没有值」，被过滤掉之后消息就少了一个头。
/// 所以读写原消息的路径（`decode_payload` / 重发）走这一对，展示层仍用 `MessageHeader`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawMessageHeader {
    pub key: String,
    /// `None` 表示 header 存在但没有值，**不是**空串。
    pub value: Option<Vec<u8>>,
}

impl RawMessageHeader {
    /// 给界面用的文本形式。非 UTF-8 的字节在这里被替换成 `�`，
    /// 但也只有这一步会「损坏」——原始字节在 `value` 里原封不动。
    pub fn to_header(&self) -> MessageHeader {
        MessageHeader {
            key: self.key.clone(),
            value: self
                .value
                .as_deref()
                .map(|raw| String::from_utf8_lossy(raw).into_owned()),
        }
    }
}

/// 分页结果。具体中间件的分页语义不同，这里只统一承载形态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub items: Vec<MessageSummary>,
    /// 是否还有更多数据（Kafka 通过 offset 游标判断）。
    pub has_more: bool,
    /// 下一页游标，前端原样回传。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 当前数据来源的展示名（topic / queue）。
    pub source: String,
}

/// 消息定位条件：在 Kafka 日志里按 key 或时间区间找消息。
///
/// `key` 与 `after` / `before` 取交集：既填 key 又填时间区间时，两个条件都要满足。
/// 为空串的 key 视为「不按 key 过滤」——表单里清空输入不该变成「找 key 为空的消息」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLocate {
    pub connection_id: String,
    /// Kafka 主题名。
    pub target: String,
    /// 按消息 key 精确匹配。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// 时间区间起点（毫秒时间戳，含）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<i64>,
    /// 时间区间终点（毫秒时间戳，含）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
    /// 按消息内容（payload）包含匹配。
    ///
    /// 与 `key` 的语义刻意不同：key 是「这条消息在哪」的坐标，必须精确；
    /// 内容是「这里面提到了什么」，只能是包含匹配，且不区分大小写。
    /// 但这是一次逐条解码的扫描，代价远高于 key 定位，因此必须有一个
    /// 时间区间或明确的确认才能发起（见 `locate::max_content_scan`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 最多返回条数，后端会做上限裁剪。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 上一页返回的续扫游标，原样回传表示「沿上次停下的位置继续」。
    ///
    /// 缺省表示从头开始。游标里记录了每个分区读到哪、以及原始条件指纹，
    /// 所以换条件后会失效（见 `locate::cursor`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// 定位结果。
///
/// 除了命中列表，还回报「扫了多少」和「为什么停下」，否则用户无法判断
/// 「筛出来 3 条」是日志里只有 3 条，还是只翻到了 3 条就放弃了。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearch {
    /// 命中的消息，同一页内按时间倒序。
    pub items: Vec<MessageSummary>,
    /// 实际解码过的消息条数（含未命中的）。
    pub scanned: u64,
    /// 是否因为到达扫描上限或时间区间边界而提前结束。
    pub truncated: bool,
    /// 扫描区间说明，例如「按时间区间 [..] 从最早位置开始扫描」。
    pub note: String,
    /// 续扫游标。为 `None` 表示已经读到日志尽头，没有更多可读了。
    ///
    /// 前端不该自己判断「还有没有」，它看不到分区状态；
    /// 这里给出断言，前端只负责把它回传。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 本次扫描起点的说明，例如「从上次停下的位置继续」。首页为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
    /// 内容扫描被条数上限提前终止时为 `true`，附一句人话说明。
    ///
    /// 与 `truncated` 分开：那个表示「这一轮没扫完」，这个表示
    /// 「按内容扫描的规则，这一轮只允许扫到这里」。合并成一个字段，
    /// 用户就分不清「再点一次能继续」和「再点一次也扫不动」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_budget: Option<String>,
    /// 条件对得上、却因为没有时间戳而无法判断是否落在区间里的消息条数说明。
    ///
    /// 这些消息到过眼前，所以扫描读到过；但它们永远进不了时间区间，
    /// 「没找到」这句话对它们不成立。只在真的遇到时才给。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undated: Option<String>,
}

/// 发送消息请求：Kafka 与 RabbitMQ 各一个变体。
///
/// 原来是一个扁平结构：`target` 一会儿是 topic 一会儿是 routing key，
/// `exchange` 在 Kafka 下永远为空，`key` 在 RabbitMQ 下永远为空。
/// 那种「填了也没用」的字段是最坏的接口——它不出错，只是默默不生效，
/// 等到有人给 RabbitMQ 消息设了 key 才发现根本没发出去。
///
/// 现在按中间件分叉，字段各归各的：AMQP 补上了投递模式与 headers，
/// Kafka 的 `key` 是实打实的分区依据。协议层面本来就不是一回事，
/// 硬塞进一个结构只会把差异藏起来。
///
/// 字段名逐个标注 `rename` 而不用 `rename_all`：与 `tag` 同时出现时
/// `rename_all` 只作用于变体名，不会递归到变体里的字段 —— 那样前端传
/// `connectionId` 会静默对不上，报的错还是「missing field connection_id」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SendRequest {
    /// 投到 topic；`key` 决定分区落点。
    Kafka {
        #[serde(rename = "connectionId")]
        connection_id: String,
        topic: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        /// 消息头。以前这一项在 Kafka 路径上被丢掉：表单传了、驱动也支持，
        /// 中间那层没接。链路追踪靠的 trace-id 正放这里。
        #[serde(default)]
        headers: Vec<MessageHeader>,
        payload: String,
    },
    /// 投到 exchange + routing key；是否需要 headers / 持久化只有 AMQP 有。
    RabbitMq {
        #[serde(rename = "connectionId")]
        connection_id: String,
        /// 空串表示默认交换机。
        #[serde(default)]
        exchange: String,
        #[serde(rename = "routingKey")]
        routing_key: String,
        payload: String,
        /// AMQP 的投递模式：`1` 非持久化、`2` 持久化。默认非持久化。
        #[serde(default = "default_delivery_mode", rename = "deliveryMode")]
        delivery_mode: u8,
        /// 内容类型，例如 `application/json`。缺省 `text/plain`。
        ///
        /// 这一格看着像装饰，实际是下游路由依据：按类型分派的消费者
        /// 收到 `text/plain` 的 JSON 会走错分支，而且不会有任何报错。
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "contentType"
        )]
        content_type: Option<String>,
        /// 内容编码，例如 `gzip` / `utf-8`。缺省不带（AMQP 视为未编码）。
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "contentEncoding"
        )]
        content_encoding: Option<String>,
        #[serde(default)]
        headers: Vec<MessageHeader>,
    },
}

/// 默认非持久化：发一条测试消息却让它写进磁盘，是把调试成本转移到磁盘上。
fn default_delivery_mode() -> u8 {
    delivery_mode::TRANSIENT
}

/// AMQP 投递模式的取值与含义。
pub mod delivery_mode {
    /// 非持久化：broker 重启后消息不保证还在。
    pub const TRANSIENT: u8 = 1;
    /// 持久化：broker 重启后消息仍在（队列本身也得是持久的才有意义）。
    pub const PERSISTENT: u8 = 2;

    /// 是不是能交给 broker 的值。其他数字由 `basic_properties` 悄悄忽略，
    /// 与其发出去了才发现没生效，不如在入口拦下。
    pub fn is_valid(value: u8) -> bool {
        value == TRANSIENT || value == PERSISTENT
    }
}

/// 默认内容类型：发消息时这一格没填就用它。
///
/// 保持与修复前一致 —— 老行为不是「对的」，但至少是已知的；
/// 顺手换一个默认值会让所有没填这一格的人的消息在下游换一条路走。
pub const DEFAULT_CONTENT_TYPE: &str = "text/plain";

/// AMQP 的 content_type / content_encoding 是不是能原样交给 broker。
///
/// 两者都是 AMQP 的 `shortstr`（最长 255 字节），超了在 `basic_publish`
/// 里会被截断或拒收，而这发生在消息已经组装好之后。长度检查放在这里，
/// 报错的时候用户还能看见自己填的是什么。
pub fn content_type_problem(value: &str) -> Option<String> {
    if value.len() > 255 {
        return Some(format!("内容类型最长 255 字节，收到 {} 字节", value.len()));
    }
    if value.contains(char::is_whitespace) {
        return Some("内容类型里不能有空格".to_owned());
    }
    None
}

/// 发送结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub kind: BrokerKind,
    /// 中间件返回的确认信息，例如 Kafka 的 partition/offset。
    pub detail: String,
    /// 这次发送**没有确定结论**：消息可能已经写进去了。
    ///
    /// 只对 Kafka 有意义（AMQP 的 publish confirm 是确定的）。有它的时候界面
    /// 不该说「发送失败」，也不该把发送按钮当成「再点一次就好」——那正是在
    /// 制造重复消息。
    #[serde(default)]
    pub unsure: bool,
    /// 这条连接上的 producer 保证被高级选项改掉时的提示（目前只有幂等）。
    ///
    /// 成功时也要下发：`detail` 里的「已写入」最容易被读成「以后也可以放心再点」，
    /// 而幂等失效时这话不成立 —— 只在下一次重发时才说，人已经又点过一次了。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub producer_warning: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 线上格式由前后端共同遵守，这里钉住字段名与分叉标记：
    /// 前端 `SendRequest` 是同一个联合类型，`kind` 拼错就会静默落成「不认识的变体」。
    #[test]
    fn kafka_request_has_no_amqp_fields() {
        let request = SendRequest::Kafka {
            connection_id: "id".to_owned(),
            topic: "orders".to_owned(),
            key: Some("k".to_owned()),
            headers: vec![MessageHeader {
                key: "trace-id".to_owned(),
                value: Some("abc".to_owned()),
            }],
            payload: "{}".to_owned(),
        };
        let json = serde_json::to_value(&request).expect("序列化失败");
        assert_eq!(json["kind"], "kafka");
        assert_eq!(json["topic"], "orders");
        assert_eq!(json["connectionId"], "id");
        assert_eq!(json["headers"][0]["key"], "trace-id");
        assert!(json.get("exchange").is_none());
        assert!(json.get("routingKey").is_none());
        assert!(json.get("deliveryMode").is_none());
    }

    /// Kafka 的 headers 以前在命令层被丢掉。前端补上这一格之后，
    /// 线格式必须先认它，否则「填了 trace-id，消费端看不到」会重现一遍。
    #[test]
    fn kafka_request_accepts_headers() {
        let request: SendRequest = serde_json::from_value(serde_json::json!({
            "kind": "kafka",
            "connectionId": "id",
            "topic": "orders",
            "headers": [{ "key": "trace-id", "value": "abc" }],
            "payload": "{}"
        }))
        .expect("反序列化失败");
        match request {
            SendRequest::Kafka { headers, .. } => {
                assert_eq!(headers.len(), 1);
                assert_eq!(headers[0].value.as_deref(), Some("abc"));
            }
            other => panic!("变体不对：{other:?}"),
        }
    }

    /// 老前端不带 headers 也得能发：字段有 `default`，不是必填。
    #[test]
    fn kafka_request_without_headers_still_parses() {
        let request: SendRequest = serde_json::from_value(serde_json::json!({
            "kind": "kafka",
            "connectionId": "id",
            "topic": "orders",
            "payload": "{}"
        }))
        .expect("反序列化失败");
        match request {
            SendRequest::Kafka { headers, .. } => assert!(headers.is_empty()),
            other => panic!("变体不对：{other:?}"),
        }
    }

    #[test]
    fn rabbit_request_carries_amqp_specifics() {
        let request: SendRequest = serde_json::from_value(serde_json::json!({
            "kind": "rabbitMq",
            "connectionId": "id",
            "exchange": "orders.exchange",
            "routingKey": "order.created",
            "payload": "{}",
            "deliveryMode": 2,
            "headers": [{ "key": "trace-id", "value": "abc" }]
        }))
        .expect("反序列化失败");

        match request {
            SendRequest::RabbitMq {
                delivery_mode,
                headers,
                routing_key,
                content_type,
                content_encoding,
                ..
            } => {
                assert_eq!(delivery_mode, delivery_mode::PERSISTENT);
                assert_eq!(routing_key, "order.created");
                assert_eq!(headers.len(), 1);
                // 没传就是「没说」，不是空串 —— 空串会让后端以为用户想发一个空类型。
                assert_eq!(content_type, None);
                assert_eq!(content_encoding, None);
            }
            _ => panic!("应解析为 RabbitMQ 请求"),
        }
    }

    #[test]
    fn rabbit_request_defaults_to_transient() {
        // 少传投递模式时默认非持久化：测试消息不该顺手写进磁盘。
        let request: SendRequest = serde_json::from_value(serde_json::json!({
            "kind": "rabbitMq",
            "connectionId": "id",
            "routingKey": "q",
            "payload": "x"
        }))
        .expect("反序列化失败");

        assert!(matches!(
            request,
            SendRequest::RabbitMq {
                delivery_mode: delivery_mode::TRANSIENT,
                ..
            }
        ));
    }

    #[test]
    fn rabbit_request_carries_content_type() {
        // 线上字段名是 camelCase；写错一个字母就等于「没填」，静默回落到 text/plain。
        let request: SendRequest = serde_json::from_value(serde_json::json!({
            "kind": "rabbitMq",
            "connectionId": "id",
            "routingKey": "q",
            "payload": "{}",
            "contentType": "application/json",
            "contentEncoding": "gzip"
        }))
        .expect("反序列化失败");

        match request {
            SendRequest::RabbitMq {
                content_type,
                content_encoding,
                ..
            } => {
                assert_eq!(content_type.as_deref(), Some("application/json"));
                assert_eq!(content_encoding.as_deref(), Some("gzip"));
            }
            _ => panic!("应解析为 RabbitMQ 请求"),
        }
    }

    #[test]
    fn unset_content_type_is_not_serialized() {
        // 序列化时不带空字段：前端据此区分「没填」与「填了空串」。
        let request = SendRequest::RabbitMq {
            connection_id: "id".to_owned(),
            exchange: String::new(),
            routing_key: "q".to_owned(),
            payload: "x".to_owned(),
            delivery_mode: delivery_mode::TRANSIENT,
            content_type: None,
            content_encoding: None,
            headers: Vec::new(),
        };
        let json = serde_json::to_value(&request).expect("序列化失败");
        assert!(json.get("contentType").is_none());
        assert!(json.get("contentEncoding").is_none());
    }

    #[test]
    fn content_type_must_be_a_single_token() {
        assert_eq!(content_type_problem("application/json"), None);
        assert!(content_type_problem("application / json").is_some());
        assert!(content_type_problem(&"a".repeat(256)).is_some());
    }

    #[test]
    fn unknown_kind_is_rejected() {
        // 拼错中间件名不能退化成某个默认分支：宁可报错，也不要发到不该去的地方。
        let parsed = serde_json::from_value::<SendRequest>(serde_json::json!({
            "kind": "rabbitmq",
            "connectionId": "id",
            "routingKey": "q",
            "payload": "x"
        }));
        assert!(parsed.is_err());
    }
}
