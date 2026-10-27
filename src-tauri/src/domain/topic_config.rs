//! Kafka 主题配置项的可编辑判定。
//!
//! 上一轮之前，配置项一直是「只读展示」——理由不是难写，而是改错一个值
//! 会当场影响数据：`retention.ms` 调小，历史消息立刻被清；`cleanup.policy`
//! 从 delete 改成 compact，存储行为整个换一套。面板不该给一个「点一下
//! 就改变数据命运」的按钮却不解释后果。
//!
//! 所以这里把规则收成纯函数，分三件事：
//! 1. 哪些配置项**根本不能改**（只读 / 改了会让 broker 起不来）；
//! 2. 值怎么校验（类型规整 + 边界）；
//! 3. 哪些改动**有副作用**，必须在确认框里说清楚。
//!
//! 不碰网络，全部可单测。前端对应 `src/lib/topic-config.ts`。

use serde::{Deserialize, Serialize};

/// 配置项的值类型。Kafka 的配置全是字符串，但校验与展示都要按类型来。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigType {
    /// 整数（可带单位后缀，如 `-1`、`86400000`）。
    Number,
    /// 布尔，服务端只认 `true` / `false`。
    Boolean,
    /// 枚举，取值来自固定集合。
    Enum,
    /// 字符串 / 列表（逗号分隔）。
    Text,
}

/// 不可编辑的原因。合并成一个 bool 的话界面只能给一句含糊的「不能改」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigLock {
    /// 可以改。
    Editable,
    /// Kafka 拒绝修改：这类值在主题创建时定型，属于 broker 级或只读元数据。
    ReadOnly,
    /// 改了会让 broker 起不来或让主题无法加载，面板不提供入口。
    Dangerous,
    /// 内部主题（`__consumer_offsets` 等），配置由 Kafka 独占管理。
    Internal,
    /// 名称不在已知配置表里：可能是新版 Kafka 的新配置，也可能是脏数据。
    Unknown,
}

impl ConfigLock {
    pub const fn is_editable(self) -> bool {
        matches!(self, Self::Editable)
    }

    pub const fn reason(self) -> Option<&'static str> {
        match self {
            Self::Editable => None,
            Self::ReadOnly => Some("Kafka 不允许在运行时修改这一项，只能在创建主题时指定"),
            Self::Dangerous => Some("改动会让 broker 或主题无法正常加载，面板不提供入口"),
            Self::Internal => Some("内部主题的配置由 Kafka 独占管理，不允许修改"),
            Self::Unknown => Some("不在已知配置表内，可能是新版 Kafka 的配置项或脏数据"),
        }
    }
}

/// 一个已知配置项的元信息。
#[derive(Debug, Clone, Copy)]
pub struct ConfigMeta {
    pub name: &'static str,
    /// 展示用名称。
    pub label: &'static str,
    pub kind: ConfigType,
    /// 枚举 / 布尔配置的允许取值；空表示不限。
    pub allowed: &'static [&'static str],
    pub lock: ConfigLock,
    /// 这一项影响的后果，写进确认框；无副作用时为 `None`。
    pub impact: Option<&'static str>,
}

impl ConfigMeta {
    const fn new(name: &'static str, label: &'static str, kind: ConfigType) -> Self {
        Self {
            name,
            label,
            kind,
            allowed: &[],
            lock: ConfigLock::Editable,
            impact: None,
        }
    }

    const fn allowed(mut self, allowed: &'static [&'static str]) -> Self {
        self.allowed = allowed;
        self
    }

    const fn lock(mut self, lock: ConfigLock) -> Self {
        self.lock = lock;
        self
    }

    const fn impact(mut self, impact: &'static str) -> Self {
        self.impact = Some(impact);
        self
    }
}

const TRUE_FALSE: &[&str] = &["true", "false"];

/// 已知配置表。
///
/// 只收录「面板上真会被人改」的那些：Kafka 有上百个主题配置，把整张表照搬
/// 过来，真正需要改的三五行照样会被淹没。表外的配置一律按 `Unknown` 处理，
/// 界面置灰并说明原因 —— 这比放行一个我们说不清后果的值更负责。
pub const KNOWN_CONFIGS: &[ConfigMeta] = &[
    ConfigMeta::new("retention.ms", "保留时长（毫秒）", ConfigType::Number)
        .impact("调小会立刻触发清理：超出新保留时长的历史消息将被删除，且不可恢复"),
    ConfigMeta::new("retention.bytes", "保留容量（字节）", ConfigType::Number)
        .impact("调小会立刻触发清理：单个分区超过新上限的旧日志段将被删除"),
    ConfigMeta::new("cleanup.policy", "清理策略", ConfigType::Enum)
        .allowed(&["delete", "compact", "delete,compact", "compact,delete"])
        .impact("从 delete 改为 compact 会改变整个日志的存储方式，历史数据不会回填"),
    ConfigMeta::new(
        "max.message.bytes",
        "单条消息上限（字节）",
        ConfigType::Number,
    )
    .impact("调小后，超限的写入会立刻被拒（含已存在的生产者）"),
    ConfigMeta::new("min.insync.replicas", "最小同步副本数", ConfigType::Number)
        .impact("调大后，可用副本不足时写入会被拒；与 acks=all 配合才生效"),
    ConfigMeta::new("segment.bytes", "日志段大小（字节）", ConfigType::Number)
        .impact("只对新建的日志段生效，已有的段不会被重切"),
    ConfigMeta::new("segment.ms", "日志段滚动时长（毫秒）", ConfigType::Number),
    ConfigMeta::new("message.timestamp.type", "时间戳类型", ConfigType::Enum)
        .allowed(&["CreateTime", "LogAppendTime"])
        .impact("切到 LogAppendTime 后，消费端拿到的是写入时间而非生产时间"),
    ConfigMeta::new(
        "message.timestamp.difference.max.ms",
        "时间戳偏差上限（毫秒）",
        ConfigType::Number,
    ),
    ConfigMeta::new(
        "unclean.leader.election.enable",
        "允许非同步副本选主",
        ConfigType::Boolean,
    )
    .allowed(TRUE_FALSE)
    .impact("开启后可能丢消息换取可用性；关闭时副本全挂的分区不可写"),
    ConfigMeta::new("compression.type", "压缩方式", ConfigType::Enum)
        .allowed(&["uncompressed", "gzip", "snappy", "lz4", "zstd", "producer"])
        .impact("改动后新旧日志段压缩方式不同，读时由 broker 自动解压"),
    ConfigMeta::new(
        "file.delete.delay.ms",
        "删除文件延迟（毫秒）",
        ConfigType::Number,
    ),
    ConfigMeta::new("flush.messages", "刷盘间隔（条）", ConfigType::Number),
    ConfigMeta::new("flush.ms", "刷盘间隔（毫秒）", ConfigType::Number),
    // 下面这些 Kafka 明确不接受运行时修改，列出来是为了让界面说清原因而不是笼统拒绝。
    ConfigMeta::new("message.format.version", "消息格式版本", ConfigType::Text)
        .lock(ConfigLock::ReadOnly),
    ConfigMeta::new("partition_count", "分区数", ConfigType::Number).lock(ConfigLock::ReadOnly),
    ConfigMeta::new("replication_factor", "副本因子", ConfigType::Number)
        .lock(ConfigLock::ReadOnly),
];

/// 查元信息。表外的配置返回 `None`。
pub fn lookup(name: &str) -> Option<&'static ConfigMeta> {
    KNOWN_CONFIGS.iter().find(|meta| meta.name == name)
}

/// 配置项的可编辑性判定。`internal` 来自主题详情。
pub fn lock_of(name: &str, internal: bool) -> ConfigLock {
    if internal {
        return ConfigLock::Internal;
    }
    match lookup(name) {
        Some(meta) => meta.lock,
        None => ConfigLock::Unknown,
    }
}

/// 一次配置项修改。`value` 为空串表示「恢复默认值」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChange {
    pub key: String,
    pub value: String,
}

/// 校验失败的原因。给界面看，文案直接可展示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigBlock {
    /// 名称不在已知表内。
    Unknown(String),
    /// 内部主题不能改。
    Internal,
    /// 该配置只读。
    ReadOnly(String),
    /// 该配置危险。
    Dangerous(String),
    /// 值不合法。
    InvalidValue { key: String, reason: String },
}

impl ConfigBlock {
    pub fn reason(&self) -> String {
        match self {
            Self::Unknown(key) => format!("`{key}` 不在已知配置表内，面板不提供修改入口"),
            Self::Internal => "内部主题的配置由 Kafka 独占管理，不允许修改".to_owned(),
            Self::ReadOnly(key) => {
                format!("`{key}` 不能在运行时修改，只能在创建主题时指定")
            }
            Self::Dangerous(key) => {
                format!("`{key}` 的改动会让 broker 或主题无法正常加载")
            }
            Self::InvalidValue { key, reason } => format!("`{key}` 的值不合法：{reason}"),
        }
    }
}

/// 校验单条改动。返回规整后的值（去空白、小写布尔等）。
pub fn validate(change: &ConfigChange, internal: bool) -> Result<String, ConfigBlock> {
    let key = change.key.trim();
    if key.is_empty() {
        return Err(ConfigBlock::InvalidValue {
            key: String::new(),
            reason: "配置项名称不能为空".to_owned(),
        });
    }

    match lock_of(key, internal) {
        ConfigLock::Internal => return Err(ConfigBlock::Internal),
        ConfigLock::ReadOnly => return Err(ConfigBlock::ReadOnly(key.to_owned())),
        ConfigLock::Dangerous => return Err(ConfigBlock::Dangerous(key.to_owned())),
        ConfigLock::Unknown => return Err(ConfigBlock::Unknown(key.to_owned())),
        ConfigLock::Editable => {}
    }

    let meta = lookup(key).expect("可编辑项必然在配置表内");
    normalize(meta, &change.value)
}

/// 按类型规整并校验取值。
fn normalize(meta: &ConfigMeta, raw: &str) -> Result<String, ConfigBlock> {
    let value = raw.trim();
    let invalid = |reason: &str| ConfigBlock::InvalidValue {
        key: meta.name.to_owned(),
        reason: reason.to_owned(),
    };

    // 空串提交等于「删掉这个覆盖项，回落到 broker 默认值」。
    if value.is_empty() {
        return Ok(String::new());
    }

    match meta.kind {
        ConfigType::Number => {
            let parsed: i64 = value
                .parse()
                .map_err(|_| invalid("需要填整数（毫秒 / 字节都按整数算）"))?;
            // `-1` 在 Kafka 里表示「不限制」，是合法取值；再小就没有意义了。
            if parsed < -1 {
                return Err(invalid("不能小于 -1（-1 表示不限制）"));
            }
            Ok(parsed.to_string())
        }
        ConfigType::Boolean => {
            let lowered = value.to_ascii_lowercase();
            if !matches!(lowered.as_str(), "true" | "false") {
                return Err(invalid("只接受 true 或 false"));
            }
            Ok(lowered)
        }
        ConfigType::Enum => {
            if meta.allowed.is_empty() {
                return Ok(value.to_owned());
            }
            if !meta.allowed.contains(&value) {
                return Err(invalid(&format!(
                    "允许的取值：{}",
                    meta.allowed.join(" / ")
                )));
            }
            Ok(value.to_owned())
        }
        ConfigType::Text => Ok(value.to_owned()),
    }
}

/// 一条可提交的改动：校验后的值 + 后果说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPlanItem {
    pub key: String,
    /// 校验并规整后的值；空串表示恢复默认值。
    pub value: String,
    /// 原先的值，用于确认框里「从什么改成什么」。
    pub previous: String,
    /// 这一项改动的后果；没有副作用时为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
}

impl ConfigPlanItem {
    /// 是否是把值清空（回落默认值）。
    pub fn is_reset(&self) -> bool {
        self.value.is_empty()
    }
}

/// 批量改配置的计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPlan {
    pub topic: String,
    pub items: Vec<ConfigPlanItem>,
    /// 提交前必须让用户读到的后果汇总，按项去重。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub impacts: Vec<String>,
}

/// 组装修改计划：逐项校验 + 只保留真正变化的项 + 汇总后果。
///
/// `current` 是当前生效的配置（`key -> value`）。
/// 返回空列表是合法结果——用户点了保存但什么都没改，不该报错，
/// 但也不该真的发一次请求出去。
pub fn plan(
    topic: &str,
    internal: bool,
    current: &[(String, String)],
    changes: &[ConfigChange],
) -> Result<ConfigPlan, ConfigBlock> {
    let current_value = |key: &str| -> String {
        current
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };

    let mut items: Vec<ConfigPlanItem> = Vec::new();
    let mut impacts: Vec<String> = Vec::new();

    for change in changes {
        let key = change.key.trim().to_owned();
        let value = validate(change, internal)?;
        let previous = current_value(&key);

        // 值没变就跳过：Kafka 会接受这种提交，但它只是给服务端递了一次无意义的变更。
        if value == previous {
            continue;
        }
        // 同一批里重复改同一项时后写的为准，避免两次提交互相覆盖。
        items.retain(|item: &ConfigPlanItem| item.key != key);

        let impact = lookup(&key).and_then(|meta| meta.impact).map(str::to_owned);
        if let Some(text) = &impact
            && !impacts.contains(text)
        {
            impacts.push(text.clone());
        }

        items.push(ConfigPlanItem {
            key,
            value,
            previous,
            impact,
        });
    }

    // 排序让确认框里的顺序稳定，不随用户点击顺序变化。
    items.sort_by(|a, b| a.key.cmp(&b.key));

    Ok(ConfigPlan {
        topic: topic.trim().to_owned(),
        items,
        impacts,
    })
}

/// 改配置的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOutcome {
    pub topic: String,
    /// 成功提交的配置项。
    pub applied: Vec<String>,
    /// 服务端接受的命令条数（一项可能被拆成多次提交）。
    pub detail: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(key: &str, value: &str) -> ConfigChange {
        ConfigChange {
            key: key.to_owned(),
            value: value.to_owned(),
        }
    }

    #[test]
    fn known_configs_are_editable() {
        assert_eq!(lock_of("retention.ms", false), ConfigLock::Editable);
        assert_eq!(lock_of("cleanup.policy", false), ConfigLock::Editable);
        assert!(ConfigLock::Editable.reason().is_none());
    }

    #[test]
    fn internal_topic_blocks_everything() {
        assert_eq!(lock_of("retention.ms", true), ConfigLock::Internal);
        let blocked = validate(&change("retention.ms", "1000"), true).unwrap_err();
        assert!(matches!(blocked, ConfigBlock::Internal));
    }

    #[test]
    fn readonly_and_unknown_are_refused() {
        assert_eq!(lock_of("partition_count", false), ConfigLock::ReadOnly);
        assert_eq!(lock_of("some.new.config", false), ConfigLock::Unknown);
        assert!(validate(&change("partition_count", "6"), false).is_err());
        assert!(validate(&change("some.new.config", "1"), false).is_err());
    }

    #[test]
    fn numbers_are_parsed_and_bounded() {
        // 带空白的输入被规整，`007` 归一成 `7`。
        assert_eq!(
            validate(&change("retention.ms", " 604800000 "), false).unwrap(),
            "604800000"
        );
        assert_eq!(
            validate(&change("retention.ms", "007"), false).unwrap(),
            "7"
        );
        // -1 合法（表示不限制），更小没有意义。
        assert_eq!(
            validate(&change("retention.ms", "-1"), false).unwrap(),
            "-1"
        );
        assert!(validate(&change("retention.ms", "-2"), false).is_err());
        assert!(validate(&change("retention.ms", "1d"), false).is_err());
    }

    #[test]
    fn booleans_are_lowercased_and_checked() {
        assert_eq!(
            validate(&change("unclean.leader.election.enable", "TRUE"), false).unwrap(),
            "true"
        );
        assert!(validate(&change("unclean.leader.election.enable", "yes"), false).is_err());
    }

    #[test]
    fn enums_are_checked_against_allowed_values() {
        assert_eq!(
            validate(&change("cleanup.policy", "compact"), false).unwrap(),
            "compact"
        );
        // 大小写敏感：服务端认的是确切取值。
        assert!(validate(&change("cleanup.policy", "Compact"), false).is_err());
        assert!(validate(&change("cleanup.policy", "delete,compact,odd"), false).is_err());
    }

    #[test]
    fn empty_value_means_reset_to_default() {
        assert_eq!(validate(&change("retention.ms", "   "), false).unwrap(), "");
    }

    #[test]
    fn plan_skips_unchanged_values() {
        let current = vec![("retention.ms".to_owned(), "1000".to_owned())];
        let plan = plan(
            "orders",
            false,
            &current,
            &[
                change("retention.ms", "1000"),
                change("segment.bytes", "1024"),
            ],
        )
        .expect("校验应通过");
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].key, "segment.bytes");
        // 没改过的项不会出现在后果汇总里。
        assert!(plan.impacts.iter().all(|text| text.contains("日志段")));
    }

    #[test]
    fn plan_keeps_last_duplicate_and_sorts() {
        let plan = plan(
            "orders",
            false,
            &[],
            &[
                change("segment.ms", "600000"),
                change("retention.ms", "1000"),
                change("retention.ms", "2000"),
            ],
        )
        .expect("校验应通过");
        assert_eq!(
            plan.items
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            ["retention.ms", "segment.ms"]
        );
        assert_eq!(plan.items[0].value, "2000");
        assert_eq!(plan.items[0].previous, "");
    }

    #[test]
    fn plan_reports_impacts_without_duplicates() {
        let plan = plan(
            "orders",
            false,
            &[],
            &[
                change("retention.ms", "1000"),
                change("retention.bytes", "1024"),
            ],
        )
        .expect("校验应通过");
        assert_eq!(plan.impacts.len(), 2);
    }

    #[test]
    fn plan_propagates_first_invalid_change() {
        let error = plan(
            "orders",
            false,
            &[],
            &[
                change("retention.ms", "1000"),
                change("retention.ms", "abc"),
            ],
        )
        .unwrap_err();
        // 同一个 key 的第二条非法，说明校验发生在去重之前 —— 这正是想要的：
        // 静默丢掉非法输入比报错更糟。
        assert!(matches!(error, ConfigBlock::InvalidValue { .. }));
    }

    #[test]
    fn plan_serializes_camel_case() {
        let plan = plan("orders", false, &[], &[change("retention.ms", "1000")]).unwrap();
        let json = serde_json::to_value(&plan).expect("序列化失败");
        assert_eq!(json["items"][0]["previous"], "");
        assert!(json["impacts"].as_array().is_some());
        assert_eq!(json["topic"], "orders");
    }
}
