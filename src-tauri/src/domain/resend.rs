//! Kafka 消息重发：把一条已经在日志里的消息重新 produce 一遍。
//!
//! Kafka 和 RabbitMQ 的「重发」不是同一件事，这也是它单独成模块的原因：
//! AMQP 的重投是「把同一条消息送回交换机」，消息是搬走的；
//! Kafka 的消息按 offset 写在日志里，无法就地移动，**重发只能是新写一条**。
//! 因此这里从不说「移动」，界面上也必须说清「原来的那条还在」。
//!
//! 重发的价值在于验证分区一致性：`topic:partition:offset` 这个 ID 里就带着
//! 原消息所在的分区，用同一个 key 再发一次，能直接看出 key 到分区的映射有没有变
//! （分区数改动、partitioner 配置不同都会让同一条 key 落到别处）。
//!
//! 规则全部是纯函数，不碰网络，可脱离 broker 单测。

use serde::{Deserialize, Serialize};

use super::MessageHeader;

/// Kafka 主题名长度上限，超过服务端一定拒绝，不如在本地拦下。
pub const TOPIC_NAME_MAX_LEN: usize = 249;

/// 重发请求。
///
/// `payload` 留空表示沿用原消息内容——这是最常见的情形：
/// 排查时想验证的是「这条消息再发一次会怎样」，不是「换一份内容发」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendRequest {
    pub connection_id: String,
    /// 原消息 ID（`topic:partition:offset`）。
    pub message_id: String,
    /// 目标 topic，留空沿用原消息所在 topic。
    #[serde(default)]
    pub topic: String,
    /// 消息 key，留空沿用原 key。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// 消息内容，留空沿用原内容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    /// 是否带上原消息的 headers（默认带）。
    #[serde(default)]
    pub keep_headers: bool,
}

/// 解析完成的重发计划：可以直接交给 producer 执行。
#[derive(Debug, Clone)]
pub struct ResendPlan {
    pub topic: String,
    pub key: Option<String>,
    pub payload: Vec<u8>,
    pub headers: Vec<MessageHeader>,
    /// 原消息所在分区，用于事后比对 key 是否还落在同一个分区。
    pub original_partition: Option<i32>,
    /// key 是否沿用原消息。只有沿用才谈得上「同一条 key 换了分区」。
    pub key_kept: bool,
}

/// 重发前的校验失败原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResendBlock {
    /// 主题名为空。
    EmptyTopic,
    /// 主题名超过长度上限。
    TopicTooLong(usize),
    /// 主题名含非法字符。
    InvalidTopic(String),
    /// 最终内容为空：原消息内容为空且用户也没填。
    EmptyPayload,
}

impl ResendBlock {
    /// 给界面看的一句话。
    pub fn reason(&self) -> String {
        match self {
            Self::EmptyTopic => "主题名不能为空".to_owned(),
            Self::TopicTooLong(len) => {
                format!("主题名 {len} 个字符，超过 Kafka 的 {TOPIC_NAME_MAX_LEN} 字符上限")
            }
            Self::InvalidTopic(name) => format!(
                "主题名 {name} 含非法字符，只允许字母、数字、点、下划线和连字符，\
                 且不能是 . 或 .."
            ),
            Self::EmptyPayload => "消息内容为空：原消息没有 payload，也没有填写新的内容".to_owned(),
        }
    }
}

/// 校验主题名。规则与 Kafka 服务端一致，只是提前一步说清楚。
pub fn validate_topic(topic: &str) -> Option<ResendBlock> {
    let topic = topic.trim();
    if topic.is_empty() {
        return Some(ResendBlock::EmptyTopic);
    }
    if topic.chars().count() > TOPIC_NAME_MAX_LEN {
        return Some(ResendBlock::TopicTooLong(topic.chars().count()));
    }
    // `.` 和 `..` 是 Kafka 明确禁止的路径别名，会被当成「当前/上级」目录。
    let valid = topic != "."
        && topic != ".."
        && topic
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !valid {
        return Some(ResendBlock::InvalidTopic(topic.to_owned()));
    }
    None
}

/// 原消息的 key / payload / headers，作为重发时的兜底来源。
#[derive(Debug, Clone, Default)]
pub struct OriginalMessage {
    pub topic: String,
    pub partition: Option<i32>,
    pub key: Option<String>,
    pub payload: Vec<u8>,
    pub headers: Vec<MessageHeader>,
}

/// 组装重发计划。
///
/// 三处「留空即沿用」都按同一逻辑处理：**去掉首尾空白之后为空才算没填**。
/// 表单里的空格是误触，不该变成「把 key 改成空格」。
pub fn build_plan(
    original: &OriginalMessage,
    request: &ResendRequest,
) -> Result<ResendPlan, ResendBlock> {
    let topic = match request.topic.trim() {
        "" => original.topic.clone(),
        topic => topic.to_owned(),
    };
    if let Some(block) = validate_topic(&topic) {
        return Err(block);
    }

    let (key, key_kept) = match request.key.as_deref().map(str::trim) {
        Some("") | None => (original.key.clone(), true),
        Some(key) => (Some(key.to_owned()), false),
    };

    let payload = match request.payload.as_deref() {
        // 内容和 key 不同：payload 的首尾空白可能就是业务数据的一部分，
        // 只把「整段都是空白」当成没填，不能擅自 trim 用户内容。
        Some(text) if !text.trim().is_empty() => text.as_bytes().to_vec(),
        _ => original.payload.clone(),
    };
    if payload.is_empty() {
        return Err(ResendBlock::EmptyPayload);
    }

    Ok(ResendPlan {
        topic,
        key,
        payload,
        headers: if request.keep_headers {
            original.headers.clone()
        } else {
            Vec::new()
        },
        original_partition: original.partition,
        key_kept,
    })
}

/// 重发结果。
///
/// 只回报「写到了哪里」和一句人话提示。刻意不复述原消息位置——
/// 重发没有动原消息，界面上写「原消息已移动」是彻底的误导。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendOutcome {
    /// 写入的主题（可能与原消息不同）。
    pub topic: String,
    /// 新消息落在哪个分区。
    pub partition: i32,
    /// 新消息的 offset。
    pub offset: i64,
    /// 落点提示：同 key 换了分区时会说明原因。
    pub note: String,
}

/// key 与分区的比对结论，只在「沿用原 key」时才有意义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum PartitionCheck {
    /// 落在了原分区，key 到分区的映射没变。
    Same,
    /// 落到了别的分区：分区数或 partitioner 配置与原消息写入时不同。
    Moved(String),
    /// 这次重发换了 key，比对不成立。
    NotComparable,
}

impl PartitionCheck {
    /// 给界面看的一句话，`None` 表示不需要提示。
    pub fn message(&self) -> Option<String> {
        match self {
            Self::Same => None,
            Self::Moved(detail) => Some(detail.clone()),
            Self::NotComparable => None,
        }
    }
}

/// 比对重发落点与原消息分区。
///
/// 这条提示存在的理由：同一个 key 换了分区，往往意味着「分区数变了」或
/// 「producer 的 partitioner 和业务方不一致」——两个都是会直接影响消费顺序的问题。
pub fn compare_partition(plan: &ResendPlan, delivered: i32) -> PartitionCheck {
    match plan.original_partition {
        // 没有 key 时分区由 partitioner 决定，换个分区什么也说明不了；
        // 换了 key 则根本不是「同一条消息的落点」在比较。
        //
        // 两个条件都要判：用户可能把原来的 key 主动填成新值（不可比），
        // 也可能原消息本来就没有 key（可比性根本不存在）。
        None => PartitionCheck::NotComparable,
        Some(_) if !plan.key_kept || plan.key.is_none() => PartitionCheck::NotComparable,
        Some(original) if original == delivered => PartitionCheck::Same,
        Some(original) => PartitionCheck::Moved(format!(
            "同一条 key 这次落到了分区 {delivered}，原消息在分区 {original}。\
             分区数变化或 partitioner 配置不同都会导致这种偏移，消费顺序可能因此改变"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn original() -> OriginalMessage {
        OriginalMessage {
            topic: "orders".to_owned(),
            partition: Some(3),
            key: Some("order-1001".to_owned()),
            payload: b"{\"id\":1001}".to_vec(),
            headers: vec![MessageHeader {
                key: "trace-id".to_owned(),
                value: "abc".to_owned(),
            }],
        }
    }

    fn request() -> ResendRequest {
        ResendRequest {
            connection_id: "c".to_owned(),
            message_id: "orders:3:1024".to_owned(),
            topic: String::new(),
            key: None,
            payload: None,
            keep_headers: true,
        }
    }

    #[test]
    fn empty_fields_fall_back_to_original() {
        let plan = build_plan(&original(), &request()).expect("应当可以重发");
        assert_eq!(plan.topic, "orders");
        assert_eq!(plan.key.as_deref(), Some("order-1001"));
        assert_eq!(plan.payload, b"{\"id\":1001}".to_vec());
        assert_eq!(plan.headers.len(), 1);
        assert_eq!(plan.original_partition, Some(3));
    }

    #[test]
    fn whitespace_only_key_means_keep_original() {
        let mut req = request();
        req.key = Some("   ".to_owned());
        let plan = build_plan(&original(), &req).expect("应当可以重发");
        assert_eq!(plan.key.as_deref(), Some("order-1001"));
    }

    #[test]
    fn explicit_values_override_original() {
        let mut req = request();
        req.topic = " orders-retry ".to_owned();
        req.key = Some("order-2002".to_owned());
        req.payload = Some(" bye ".to_owned());

        let plan = build_plan(&original(), &req).expect("应当可以重发");
        assert_eq!(plan.topic, "orders-retry");
        assert_eq!(plan.key.as_deref(), Some("order-2002"));
        // payload 不 trim：首尾空白可能是业务数据本身。
        assert_eq!(plan.payload, b" bye ".to_vec());
    }

    #[test]
    fn headers_can_be_dropped() {
        let mut req = request();
        req.keep_headers = false;
        assert!(
            build_plan(&original(), &req)
                .expect("应当可以重发")
                .headers
                .is_empty()
        );
    }

    #[test]
    fn empty_payload_and_no_override_is_blocked() {
        let mut source = original();
        source.payload = Vec::new();
        let error = build_plan(&source, &request()).expect_err("空内容不该放行");
        assert_eq!(error, ResendBlock::EmptyPayload);

        let mut req = request();
        req.payload = Some("   ".to_owned());
        assert_eq!(
            build_plan(&source, &req).expect_err("全是空白也不放行"),
            ResendBlock::EmptyPayload
        );
    }

    #[test]
    fn topic_validation_matches_kafka_rules() {
        assert_eq!(validate_topic("  "), Some(ResendBlock::EmptyTopic));
        assert_eq!(
            validate_topic("."),
            Some(ResendBlock::InvalidTopic(".".to_owned()))
        );
        assert_eq!(
            validate_topic(".."),
            Some(ResendBlock::InvalidTopic("..".to_owned()))
        );
        assert!(matches!(
            validate_topic("订单"),
            Some(ResendBlock::InvalidTopic(_))
        ));
        assert!(matches!(
            validate_topic("ns/orders"),
            Some(ResendBlock::InvalidTopic(_))
        ));
        assert_eq!(validate_topic("ns.orders_v2-1"), None);

        let long = "a".repeat(TOPIC_NAME_MAX_LEN + 1);
        assert_eq!(
            validate_topic(&long),
            Some(ResendBlock::TopicTooLong(TOPIC_NAME_MAX_LEN + 1))
        );
        assert_eq!(validate_topic(&"a".repeat(TOPIC_NAME_MAX_LEN)), None);
    }

    #[test]
    fn partition_check_flags_moved_key() {
        let plan = build_plan(&original(), &request()).expect("应当可以重发");
        assert_eq!(compare_partition(&plan, 3), PartitionCheck::Same);
        assert!(compare_partition(&plan, 3).message().is_none());

        let moved = compare_partition(&plan, 5);
        assert!(matches!(moved, PartitionCheck::Moved(_)));
        let text = moved.message().expect("落到别的分区应当有提示");
        assert!(text.contains('5') && text.contains('3'));
    }

    #[test]
    fn partition_check_is_skipped_without_key() {
        // 原消息没有 key：分区完全由 partitioner 决定，换个分区不代表任何事。
        let mut source = original();
        source.key = None;
        let plan = build_plan(&source, &request()).expect("应当可以重发");
        assert_eq!(compare_partition(&plan, 5), PartitionCheck::NotComparable);

        // 用户换了 key：这不是「同一条 key 漂移了」，新旧分区不可比。
        let mut req = request();
        req.key = Some("order-2002".to_owned());
        let plan = build_plan(&original(), &req).expect("应当可以重发");
        assert_eq!(compare_partition(&plan, 5), PartitionCheck::NotComparable);
    }

    #[test]
    fn partition_check_flags_moved_key_when_key_kept() {
        // 留空 key 且原消息有 key：沿用了原 key，落点变了才是真信号。
        let mut req = request();
        req.key = Some("  ".to_owned());
        let plan = build_plan(&original(), &req).expect("应当可以重发");
        assert!(matches!(
            compare_partition(&plan, 5),
            PartitionCheck::Moved(_)
        ));
    }
}
