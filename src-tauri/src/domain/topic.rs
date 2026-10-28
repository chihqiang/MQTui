//! Kafka 主题相关的领域模型：分区布局、主题详情，以及主题的增删与扩容。
//!
//! 与 `domain/message.rs` 分开：那里是「读消息」，这里是「看/改主题本身」，
//! 两者的调用路径与失败模式都不一样（改主题要 AdminClient，读消息不用）。
//! 前端对应 `src/types/topic.ts`。

use serde::{Deserialize, Serialize};

use super::{BrokerKind, KeyValue};

/// 单个分区的布局：副本分布在哪几个节点、谁是 leader。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPartitionInfo {
    pub partition: i32,
    /// 当前的 leader 节点；集群正在选主时可能为空。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leader: Option<i32>,
    /// 全部副本所在节点，顺序即副本顺序。
    pub replicas: Vec<i32>,
    /// 已同步的副本。比 `replicas` 少说明有副本掉队，此时 leader 成了单点。
    pub in_sync_replicas: Vec<i32>,
    /// 起始位点（最早可读）。
    pub low: i64,
    /// 末尾位点（最新可写）。
    pub high: i64,
    /// 水位读到了没有。
    ///
    /// 读不到时 `low` / `high` 都是 0，而 `high - low` 恰好是 0 —— 于是
    /// 「权限不足 / leader 迁移中 / 请求超时」在界面上长得和「这个分区是空的」
    /// 一模一样。主题详情页的整页结论（「N 个分区 · M 条消息」）就是这些数加起来的，
    /// 一个读不到的分区会把总量悄悄拉低，没人看得出少算过。
    ///
    /// 默认 `true`：早先的调用方（以及序列化回来的老数据）没有这个字段，
    /// 把「没提」读成「读不到」会让所有测试与缓存一起变成未知。
    #[serde(default = "default_watermarks_read")]
    pub watermarks_read: bool,
}

/// `watermarks_read` 的缺省值：没提这件事时按「读到了」处理。
fn default_watermarks_read() -> bool {
    true
}

impl TopicPartitionInfo {
    /// 这个分区的水位读到了没有。读不到时任何条数结论都不该成立。
    pub const fn has_watermarks(&self) -> bool {
        self.watermarks_read
    }
}

impl TopicPartitionInfo {
    /// 该分区当前可读的消息条数；水位读不到时是 `None`。
    ///
    /// 返回 `Option` 而不是 0：0 是一个结论（「这个分区空了」），
    /// 而读不到水位是「不知道」。面板上把不知道显示成 0，会让人以为
    /// 消息被消费光了或者被 retention 清掉了 —— 于是去查一个并不存在的问题。
    pub fn messages(&self) -> Option<i64> {
        self.has_watermarks().then(|| (self.high - self.low).max(0))
    }

    /// 是否所有副本都同步。单副本主题恒为真。
    ///
    /// 比集合而不是比长度：副本从 `[1, 2, 3]` 变成 `[1, 2, 4]`，长度没变，
    /// 但对齐看是两个不同的东西 —— 3 号节点掉队、4 号节点在追数据，
    /// 此刻 leader 已经是单点。只比长度会把这行显示成「已同步」。
    pub fn is_in_sync(&self) -> bool {
        self.replicas
            .iter()
            .all(|node| self.in_sync_replicas.contains(node))
            && self.in_sync_replicas.len() == self.replicas.len()
    }
}

/// 主题详情：分区布局 + 水位 + 配置项。
///
/// 一份数据回答三个常见问题：分区/副本在哪些节点、有没有副本掉队、
/// 每个分区积了多少消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDetail {
    pub name: String,
    pub partitions: Vec<TopicPartitionInfo>,
    /// 主题级配置项（`retention.ms`、`cleanup.policy` 等），已转成可读字符串。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub configs: Vec<KeyValue>,
    /// 服务端上报的内部标记（`__consumer_offsets` 等），这类主题不应被面板修改。
    #[serde(default)]
    pub internal: bool,
}

impl TopicDetail {
    /// 全部可读消息总量；有分区水位读不到时是 `None`（部分之和不是总量）。
    pub fn total_messages(&self) -> Option<i64> {
        self.partitions
            .iter()
            .map(TopicPartitionInfo::messages)
            .sum()
    }

    /// 水位读不到的分区号。界面据此说「这几个分区的条数是未知」。
    pub fn unknown_watermarks(&self) -> Vec<i32> {
        self.partitions
            .iter()
            .filter(|item| !item.has_watermarks())
            .map(|item| item.partition)
            .collect()
    }

    /// 分区数。
    pub fn partition_count(&self) -> usize {
        self.partitions.len()
    }

    /// 是否所有分区都全部副本同步。
    pub fn is_healthy(&self) -> bool {
        self.partitions.iter().all(TopicPartitionInfo::is_in_sync)
    }
}

/// 新建主题请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicSpec {
    pub name: String,
    pub partitions: i32,
    /// 副本因子。0 或缺失表示「交给服务端默认值」。
    #[serde(default)]
    pub replication_factor: i32,
    /// 附加配置项，键值原样透传（例如 `retention.ms`）。
    #[serde(default)]
    pub configs: Vec<KeyValue>,
}

/// 主题名允许的字符集：字母、数字、`.`、`_`、`-`。
///
/// Kafka 对非法名字只在服务端拒绝，报错是 `INVALID_TOPIC_EXCEPTION`，
/// 离用户填的表单太远，这里先拦一道。
fn is_valid_topic_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')
}

impl TopicSpec {
    /// 入参校验，错误文案可直接展示。
    pub fn validate(&self) -> Result<(), String> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err("主题名称不能为空".to_owned());
        }
        // 按字符数而不是字节数：Kafka 的 249 上限是字符数，而 `len()` 给的是字节数。
        // 用字节数会把 83 个汉字（249 字节）判成超长，可服务端明明收得下；
        // 反过来 ASCII 名字两者相等，所以这个错只在非 ASCII 名字上暴露。
        let chars = name.chars().count();
        if chars > TOPIC_NAME_MAX_LEN {
            return Err(format!(
                "主题名称不能超过 {TOPIC_NAME_MAX_LEN} 个字符（当前 {chars} 个）"
            ));
        }
        if !name.chars().all(is_valid_topic_char) {
            return Err("主题名称只能包含字母、数字、`.`、`_`、`-`".to_owned());
        }
        // `.` 与 `..` 是两个真实存在的路径别名，Kafka 明确禁止。
        if matches!(name, "." | "..") {
            return Err("`.` 与 `..` 不能作为主题名称".to_owned());
        }
        if self.partitions < 1 {
            return Err("分区数至少为 1".to_owned());
        }
        if self.replication_factor < 0 {
            return Err("副本因子不能为负数（留 0 表示使用服务端默认值）".to_owned());
        }
        Ok(())
    }

    /// 规范化后的名字，去掉首尾空白。
    pub fn normalized_name(&self) -> String {
        self.name.trim().to_owned()
    }
}

/// 主题名长度上限，与 Kafka 的 `max.name.length` 默认值一致。
pub const TOPIC_NAME_MAX_LEN: usize = 249;

/// 分区扩容请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionExpansion {
    pub topic: String,
    pub partitions: i32,
}

impl PartitionExpansion {
    /// 校验扩容请求。`current` 是当前分区数。
    pub fn validate(&self, current: usize) -> Result<(), String> {
        if self.partitions < 1 {
            return Err("目标分区数至少为 1".to_owned());
        }
        let target = self.partitions as usize;
        if target == current {
            return Err(format!("当前已经是 {current} 个分区，无需扩容"));
        }
        if target < current {
            // Kafka 不支持减少分区：已有的分区键会失去归属，历史上没有实现过。
            return Err(format!(
                "Kafka 不支持减少分区（当前 {current} 个，目标 {target} 个）"
            ));
        }
        Ok(())
    }
}

/// 主题删除的可删性判定。
///
/// 与交换机删除同一个思路：把服务端约束在本地收成一个纯函数，
/// 界面上先置灰并写明原因，而不是点一下吃一个服务端错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopicRemoval {
    Allowed,
    /// 内部主题，由 Kafka 自己维护。
    Internal,
    /// 名称不合规（多半是界面上的脏数据）。
    InvalidName,
}

impl TopicRemoval {
    pub fn evaluate(name: &str, internal: bool) -> Self {
        if internal || name.starts_with("__") {
            Self::Internal
        } else if name.trim().is_empty() || !name.chars().all(is_valid_topic_char) {
            Self::InvalidName
        } else {
            Self::Allowed
        }
    }

    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::Allowed => None,
            Self::Internal => Some("内部主题（`__` 前缀）由 Kafka 维护，不可删除"),
            Self::InvalidName => Some("主题名称不合法，无法定位到具体主题"),
        }
    }
}

/// 主题运维能力：写操作该不该亮按钮，由「连接能力 + 主题属性」共同决定。
///
/// 单独成一个纯函数是为了让前端不必重复这套判断，也不必为 Kafka / 其它中间件
/// 各写一份 if-else。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicCapabilities {
    pub can_create: bool,
    pub can_delete: bool,
    pub can_expand: bool,
    /// 不能操作时的原因，按字段给出便于界面逐项提示。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasons: Vec<KeyValue>,
}

impl TopicCapabilities {
    /// 无主题上下文（例如主题列表页）时的能力：只能建，不能删/扩容。
    pub fn listing() -> Self {
        Self {
            can_create: true,
            can_delete: false,
            can_expand: false,
            reasons: Vec::new(),
        }
    }

    /// 按主题属性推导能力。
    pub fn for_topic(detail: &TopicDetail) -> Self {
        let removal = TopicRemoval::evaluate(&detail.name, detail.internal);
        // 可删性 = 允许删除；扩容则额外要求「不是内部主题」，
        // 内部主题的分区布局也被 Kafka 自己管着，改了会直接影响提交位点表。
        let deletable = removal.is_allowed();
        let replicable = !matches!(removal, TopicRemoval::Internal);

        let mut reasons = Vec::new();
        if let Some(reason) = removal.reason() {
            reasons.push(KeyValue::new("delete", reason));
        }
        if !replicable {
            reasons.push(KeyValue::new(
                "expand",
                "内部主题的分区数由 Kafka 自行管理，不可扩容",
            ));
        }

        Self {
            can_create: true,
            can_delete: deletable,
            can_expand: replicable,
            reasons,
        }
    }
}

/// 写操作的结果，携带中间件返回的确认信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicOutcome {
    pub kind: BrokerKind,
    pub topic: String,
    pub detail: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, partitions: i32, replication: i32) -> TopicSpec {
        TopicSpec {
            name: name.to_owned(),
            partitions,
            replication_factor: replication,
            configs: Vec::new(),
        }
    }

    /// 造一个「字符数 = 249，但字节数 > 249」的名字。
    ///
    /// 主题名的字符集只允许 ASCII，所以这类名字在 Kafka 眼里本来也不合法 ——
    /// 这条用例要钉的是**长度判断的顺序**：先用字符数判，再判字符集。
    /// 如果长度按字节数算，同样的名字会先被报「超过 249 个字符」，
    /// 用户照着提示改长度永远改不对。这里断言的是后者该出现的文案。
    fn wide_name() -> String {
        // 124 + 1 + 124 = 249 字符；全角空格占 3 字节，总字节数 251。
        // 用真实字符而不是 `\u{3000}` 转义：把转义写进 `format!` 只会得到六个字面字符。
        let pad = char_from(0x3000);
        format!("{}{pad}{}", "a".repeat(124), "a".repeat(124))
    }

    fn char_from(code: u32) -> char {
        char::from_u32(code).expect("合法码位")
    }

    #[test]
    fn topic_name_length_is_counted_in_chars() {
        let wide = wide_name();
        assert_eq!(wide.chars().count(), TOPIC_NAME_MAX_LEN);
        assert!(
            wide.len() > TOPIC_NAME_MAX_LEN,
            "前提：字节数已超上限（{}）",
            wide.len()
        );

        // 长度这一关过了，才会走到字符集那一关。按字节数算的话这里报的是长度错误。
        let error = spec(&wide, 1, 1).validate().unwrap_err();
        assert!(
            error.contains("只能包含"),
            "长度不该按字节数判，实际文案：{error}"
        );
    }

    #[test]
    fn spec_rejects_blank_and_long_names() {
        assert!(spec("  ", 1, 1).validate().is_err());
        let long = "a".repeat(TOPIC_NAME_MAX_LEN + 1);
        assert!(spec(&long, 1, 1).validate().is_err());
    }

    #[test]
    fn spec_rejects_illegal_characters() {
        for name in ["orders/created", "订单", "orders paid", "a,b"] {
            assert!(spec(name, 1, 1).validate().is_err(), "{name}");
        }
    }

    #[test]
    fn spec_rejects_path_aliases() {
        assert!(spec(".", 1, 1).validate().is_err());
        assert!(spec("..", 1, 1).validate().is_err());
        assert!(spec("order.created", 1, 1).validate().is_ok());
    }

    #[test]
    fn spec_checks_partitions_and_replication() {
        assert!(spec("orders", 0, 1).validate().is_err());
        assert!(spec("orders", 1, -1).validate().is_err());
        // 0 表示交给服务端默认值。
        assert!(spec("orders", 1, 0).validate().is_ok());
    }

    #[test]
    fn spec_trims_name() {
        assert_eq!(spec("  orders  ", 1, 1).normalized_name(), "orders");
    }

    #[test]
    fn expansion_only_grows() {
        let expansion = |partitions: i32| PartitionExpansion {
            topic: "orders".to_owned(),
            partitions,
        };
        assert!(expansion(6).validate(3).is_ok());
        assert!(expansion(3).validate(3).is_err());
        assert!(expansion(2).validate(3).is_err());
        assert!(expansion(0).validate(3).is_err());
    }

    #[test]
    fn removal_follows_server_constraints() {
        assert_eq!(
            TopicRemoval::evaluate("orders", false),
            TopicRemoval::Allowed
        );
        assert_eq!(
            TopicRemoval::evaluate("__consumer_offsets", false),
            TopicRemoval::Internal
        );
        // 服务端上报 internal 时即便名字没有 `__` 前缀也算内部主题。
        assert_eq!(
            TopicRemoval::evaluate("orders", true),
            TopicRemoval::Internal
        );
        assert_eq!(
            TopicRemoval::evaluate("orders/1", false),
            TopicRemoval::InvalidName
        );
        assert!(TopicRemoval::Allowed.reason().is_none());
        assert!(TopicRemoval::Internal.reason().is_some());
        assert!(TopicRemoval::InvalidName.reason().is_some());
    }

    fn detail(name: &str, internal: bool) -> TopicDetail {
        TopicDetail {
            name: name.to_owned(),
            partitions: Vec::new(),
            configs: Vec::new(),
            internal,
        }
    }

    #[test]
    fn capabilities_follow_removal_rules() {
        let normal = TopicCapabilities::for_topic(&detail("orders", false));
        assert!(normal.can_create && normal.can_delete && normal.can_expand);
        assert!(normal.reasons.is_empty());

        let internal = TopicCapabilities::for_topic(&detail("__consumer_offsets", false));
        assert!(internal.can_create);
        assert!(!internal.can_delete);
        assert!(!internal.can_expand);
        assert_eq!(internal.reasons.len(), 2);
    }

    #[test]
    fn listing_can_only_create() {
        let caps = TopicCapabilities::listing();
        assert!(caps.can_create);
        assert!(!caps.can_delete);
        assert!(!caps.can_expand);
    }

    fn partition(replicas: &[i32], isr: &[i32], low: i64, high: i64) -> TopicPartitionInfo {
        TopicPartitionInfo {
            partition: 0,
            leader: replicas.first().copied(),
            replicas: replicas.to_vec(),
            in_sync_replicas: isr.to_vec(),
            low,
            high,
            watermarks_read: true,
        }
    }

    #[test]
    fn partition_reports_lag_and_sync() {
        let healthy = partition(&[1, 2], &[1, 2], 10, 25);
        assert_eq!(healthy.messages(), Some(15));
        assert!(healthy.is_in_sync());

        let degraded = partition(&[1, 2], &[1], 10, 25);
        assert!(!degraded.is_in_sync());

        // 位点被 retention 回退时不能给出负的消息数。
        let shrunk = partition(&[1], &[1], 30, 10);
        assert_eq!(shrunk.messages(), Some(0));
    }

    #[test]
    fn sync_compares_members_not_length() {
        // 副本换了人但数量不变：3 号掉队、4 号在追数据，leader 已成单点。
        // 只比长度会把这行报成「已同步」—— 面板上绿灯，集群里没冗余。
        let swapped = partition(&[1, 2, 3], &[1, 2, 4], 0, 10);
        assert!(!swapped.is_in_sync());
        assert!(
            !TopicDetail {
                partitions: vec![swapped],
                ..detail("orders", false)
            }
            .is_healthy()
        );

        // 顺序不同不算不同步：ISR 的集合相同即可。
        let reordered = partition(&[1, 2, 3], &[3, 1, 2], 0, 10);
        assert!(reordered.is_in_sync());
    }

    #[test]
    fn unknown_watermarks_are_not_zero_messages() {
        // 回归：水位读不到时低位点与高位点都退化成 0，`high - low` 也恰好是 0 ——
        // 「权限不足 / leader 迁移中」在界面上和「这个分区是空的」一模一样。
        // 页头那句「N 个分区 · M 条消息」是这些数加出来的，一个读不到的分区
        // 会把总量悄悄拉低，而没人看得出少算过。
        let mut detail = detail("orders", false);
        let known = partition(&[1], &[1], 0, 10);
        let unknown = TopicPartitionInfo {
            watermarks_read: false,
            ..partition(&[1], &[1], 0, 0)
        };
        detail.partitions = vec![known.clone(), unknown.clone()];

        assert_eq!(unknown.messages(), None, "读不到不等于 0 条");
        assert_eq!(known.messages(), Some(10));
        // 部分之和不是总量：宁可说「不知道」，也不能报一个偏小的数。
        assert_eq!(detail.total_messages(), None);
        assert_eq!(detail.unknown_watermarks(), vec![0]);
    }

    #[test]
    fn watermarks_read_defaults_to_true_when_absent() {
        // 老数据 / 老调用方不带这个字段：读成「读不到」会让所有缓存变成未知。
        let json = serde_json::json!({
            "partition": 3,
            "replicas": [1],
            "inSyncReplicas": [1],
            "low": 0,
            "high": 7
        });
        let info: TopicPartitionInfo = serde_json::from_value(json).expect("反序列化失败");
        assert!(info.watermarks_read);
        assert_eq!(info.messages(), Some(7));
    }

    #[test]
    fn detail_sums_messages_and_health() {
        let mut detail = detail("orders", false);
        detail.partitions = vec![
            partition(&[1, 2], &[1, 2], 0, 10),
            partition(&[2, 3], &[2], 5, 8),
        ];
        assert_eq!(detail.total_messages(), Some(13));
        assert_eq!(detail.partition_count(), 2);
        assert!(!detail.is_healthy());
    }

    #[test]
    fn detail_serializes_camel_case() {
        let mut detail = detail("orders", false);
        detail.partitions = vec![partition(&[1, 2], &[1, 2], 0, 10)];
        detail.configs = vec![KeyValue::new("retention.ms", "604800000")];
        let json = serde_json::to_value(&detail).expect("序列化失败");
        assert_eq!(json["partitions"][0]["inSyncReplicas"][1], 2);
        assert_eq!(json["configs"][0]["key"], "retention.ms");
    }
}
