//! Kafka 主题配置项与 broker 版本的兼容性。
//!
//! 之前改配置只校验「类型对不对、取值合不合法」，但不校验「这个版本的 Kafka
//! 认不认这一项」。结果是：4.x 集群上填一个 3.9 才有的配置，提交被服务端拒；
//! 或者 2.x 集群上填一个只有新版才支持的取值，同样被拒 —— 报错信息往往只有一句
//! `INVALID_CONFIG`，用户完全不知道是版本问题。
//!
//! 这一层把「哪一项从哪个版本开始有」写成一张表，拿集群版本一比就能提前给结论：
//! 要么拦下，要么只是提醒。不碰网络，全部可单测。
//!
//! 两条刻意的设计：
//!
//! 1. **版本未知时不拦**。老集群的 `ApiVersions` 可能拿不到，`__consumer_offsets`
//!    之类的内部资源也可能读不到版本。这时给 `unknown` 让按钮照旧可点，
//!    而不是把功能整个锁死 —— 探测不到不等于不支持。
//! 2. **只在「确定不支持」时拦**。比版本更新（`newer`）只提醒，因为版本表本身
//!    是人工维护的，可能落后于集群；拦下会把一个真能用的配置项判成非法。

use serde::{Deserialize, Serialize};

/// 三档版本判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VersionVerdict {
    /// 当前版本能改。
    Supported,
    /// 当前版本看起来不支持 —— 只在确定时给出，界面拦下。
    Unsupported,
    /// 拿不到集群版本，无法判断。界面照旧放行。
    Unknown,
}

impl VersionVerdict {
    pub const fn is_blocking(self) -> bool {
        matches!(self, Self::Unsupported)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Supported => "版本支持",
            Self::Unsupported => "版本不支持",
            Self::Unknown => "版本未知",
        }
    }
}

/// 一项配置的版本要求。
#[derive(Debug, Clone, Copy)]
pub struct ConfigVersionRule {
    /// 配置项名称，与 `topic_config::KNOWN_CONFIGS` 一一对应。
    pub name: &'static str,
    /// 从哪个 Kafka 版本开始提供，形如 `2.8`。
    pub since: &'static str,
    /// 只在某些版本区间内有效（例如已被废弃、或仅 KRaft 模式可用）。
    pub note: Option<&'static str>,
}

impl ConfigVersionRule {
    const fn new(name: &'static str, since: &'static str) -> Self {
        Self {
            name,
            since,
            note: None,
        }
    }

    const fn noted(mut self, note: &'static str) -> Self {
        self.note = Some(note);
        self
    }
}

/// 版本表。
///
/// 只收录面板上真能改的那几项（与 `KNOWN_CONFIGS` 的可编辑项一致）。
/// 表外的配置按「未知」处理：我们不掌握它的版本信息，就不该假装掌握。
pub const VERSION_RULES: &[ConfigVersionRule] = &[
    ConfigVersionRule::new("retention.ms", "0.8"),
    ConfigVersionRule::new("retention.bytes", "0.8"),
    ConfigVersionRule::new("cleanup.policy", "0.8"),
    ConfigVersionRule::new("max.message.bytes", "0.8"),
    ConfigVersionRule::new("min.insync.replicas", "0.9"),
    ConfigVersionRule::new("segment.bytes", "0.8"),
    ConfigVersionRule::new("segment.ms", "0.8"),
    ConfigVersionRule::new("message.timestamp.type", "0.10")
        .noted("LogAppendTime 只在 0.10 及以上有效"),
    ConfigVersionRule::new("message.timestamp.difference.max.ms", "0.10"),
    ConfigVersionRule::new("unclean.leader.election.enable", "0.11"),
    ConfigVersionRule::new("compression.type", "0.8")
        .noted("zstd 需要 2.1 及以上，更老的集群只认 gzip / snappy / lz4"),
    ConfigVersionRule::new("file.delete.delay.ms", "0.8"),
    ConfigVersionRule::new("flush.messages", "0.8"),
    ConfigVersionRule::new("flush.ms", "0.8"),
];

/// 查版本规则。
pub fn rule_of(name: &str) -> Option<&'static ConfigVersionRule> {
    VERSION_RULES.iter().find(|rule| rule.name == name)
}

/// 解析 `major.minor[.patch]` 形式的版本号。
///
/// 只取前两段：Kafka 的配置项是按 minor 版本引入的，patch 不影响「有没有这一项」。
/// 解析不了就返回 `None`，由调用方按「版本未知」处理 —— 猜一个默认版本比不判断更坏。
pub fn parse_cluster_version(raw: &str) -> Option<(u32, u32)> {
    let cleaned = raw.trim().trim_start_matches('v');
    let mut parts = cleaned.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    // 只给了大版本（`3`）无法定位到具体能力，按无法解析处理：
    // 猜一个 minor 比不判断更坏。
    let minor_raw = parts.next()?;
    let digits: String = minor_raw.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    Some((major, digits.parse().ok()?))
}

/// 一条配置项的版本判定结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigVersionCheck {
    pub name: String,
    pub verdict: VersionVerdict,
    /// 该配置项引入的版本。`None` 表示不在版本表里。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// 一行可直接展示的说明。
    pub message: String,
}

/// 判断单个配置项在给定集群版本上能不能改。
///
/// `cluster` 是解析后的 `(major, minor)`；`None` 表示拿不到版本。
pub fn check(name: &str, cluster: Option<(u32, u32)>) -> ConfigVersionCheck {
    let Some(rule) = rule_of(name) else {
        return ConfigVersionCheck {
            name: name.to_owned(),
            verdict: VersionVerdict::Unknown,
            since: None,
            message: "不在版本表内，面板无法判断这一项在集群上的可用性".to_owned(),
        };
    };

    let Some(cluster) = cluster else {
        return ConfigVersionCheck {
            name: name.to_owned(),
            verdict: VersionVerdict::Unknown,
            since: Some(rule.since.to_owned()),
            message: format!(
                "读不到集群版本，未做兼容性校验（这一项需要 Kafka {} 及以上）",
                rule.since
            ),
        };
    };

    let Some(required) = parse_cluster_version(rule.since) else {
        return ConfigVersionCheck {
            name: name.to_owned(),
            verdict: VersionVerdict::Unknown,
            since: Some(rule.since.to_owned()),
            message: "版本表里的条目无法解析，未做兼容性校验".to_owned(),
        };
    };

    if cluster < required {
        return ConfigVersionCheck {
            name: name.to_owned(),
            verdict: VersionVerdict::Unsupported,
            since: Some(rule.since.to_owned()),
            message: format!(
                "集群版本 {}.{} 低于该项要求的 {}，提交会被服务端拒绝",
                cluster.0, cluster.1, rule.since
            ),
        };
    }

    ConfigVersionCheck {
        name: name.to_owned(),
        verdict: VersionVerdict::Supported,
        since: Some(rule.since.to_owned()),
        message: match rule.note {
            Some(note) => format!("集群版本满足要求；注意：{note}"),
            None => format!("集群版本满足要求（需要 {} 及以上）", rule.since),
        },
    }
}

/// 一次改配置的版本体检结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCompatReport {
    /// 集群版本原文，`None` 表示没读到。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cluster_version: Option<String>,
    /// 是否所有项都通过。
    pub ok: bool,
    pub items: Vec<ConfigVersionCheck>,
}

impl ConfigCompatReport {
    /// 被拦下的项名，界面上可以直接列出来。
    pub fn blocking(&self) -> Vec<&str> {
        self.items
            .iter()
            .filter(|item| item.verdict.is_blocking())
            .map(|item| item.name.as_str())
            .collect()
    }
}

/// 对一批改动做版本体检。
///
/// `ok` 只看有没有被拦下的项；`unknown` 不算失败 —— 探测不到版本不等于不支持。
pub fn report(
    names: &[String],
    cluster: Option<(u32, u32)>,
    raw_version: Option<&str>,
) -> ConfigCompatReport {
    let mut items: Vec<ConfigVersionCheck> =
        names.iter().map(|name| check(name, cluster)).collect();
    // 顺序稳定，确认框里的提示不会随用户点击顺序变化。
    items.sort_by(|a, b| a.name.cmp(&b.name));
    let ok = !items.iter().any(|item| item.verdict.is_blocking());
    ConfigCompatReport {
        cluster_version: raw_version.map(str::to_owned),
        ok,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_version_shapes() {
        assert_eq!(parse_cluster_version("3.7.1"), Some((3, 7)));
        assert_eq!(parse_cluster_version(" v2.8 "), Some((2, 8)));
        assert_eq!(parse_cluster_version("2.8.0-SNAPSHOT"), Some((2, 8)));
        assert_eq!(parse_cluster_version("2"), None);
        assert_eq!(parse_cluster_version("kafka"), None);
        assert_eq!(parse_cluster_version(""), None);
    }

    #[test]
    fn older_cluster_blocks_new_config() {
        let result = check("message.timestamp.type", Some((0, 9)));
        assert_eq!(result.verdict, VersionVerdict::Unsupported);
        assert!(result.message.contains("0.9"));
        assert!(result.verdict.is_blocking());
    }

    #[test]
    fn same_version_passes() {
        // 2.8 提供 unclean.leader.election.enable（0.11），应当放行。
        let result = check("unclean.leader.election.enable", Some((2, 8)));
        assert_eq!(result.verdict, VersionVerdict::Supported);
        assert!(!result.verdict.is_blocking());
    }

    #[test]
    fn unknown_version_never_blocks() {
        let result = check("retention.ms", None);
        assert_eq!(result.verdict, VersionVerdict::Unknown);
        // 探测不到不等于不支持：这里必须放行，否则老集群整个功能被锁死。
        assert!(!result.verdict.is_blocking());
    }

    #[test]
    fn config_outside_table_is_unknown() {
        let result = check("some.brand.new.config", Some((3, 7)));
        assert_eq!(result.verdict, VersionVerdict::Unknown);
        assert!(result.since.is_none());
        assert!(!result.verdict.is_blocking());
    }

    #[test]
    fn report_blocks_only_when_something_is_unsupported() {
        let names = vec![
            "retention.ms".to_owned(),
            "message.timestamp.type".to_owned(),
        ];
        let strict = report(&names, Some((0, 9)), Some("0.9.0"));
        assert!(!strict.ok);
        assert_eq!(strict.blocking(), vec!["message.timestamp.type"]);
        assert_eq!(strict.cluster_version.as_deref(), Some("0.9.0"));

        let fine = report(&names, Some((3, 7)), Some("3.7.0"));
        assert!(fine.ok);
        assert!(fine.blocking().is_empty());
    }

    #[test]
    fn unknown_version_report_is_ok() {
        let names = vec!["message.timestamp.type".to_owned()];
        let result = report(&names, None, None);
        // 未知不算失败，否则「读不到版本」会变成「什么都不能改」。
        assert!(result.ok);
        assert!(result.cluster_version.is_none());
    }

    #[test]
    fn report_items_are_sorted() {
        let names = vec!["segment.ms".to_owned(), "cleanup.policy".to_owned()];
        let result = report(&names, Some((3, 0)), Some("3.0.0"));
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["cleanup.policy", "segment.ms"]
        );
    }

    #[test]
    fn serializes_camel_case() {
        let names = vec!["retention.ms".to_owned()];
        let result = report(&names, Some((3, 7)), Some("3.7.0"));
        let json = serde_json::to_value(&result).expect("序列化失败");
        assert_eq!(json["ok"], true);
        assert_eq!(json["clusterVersion"], "3.7.0");
        assert_eq!(json["items"][0]["verdict"], "supported");
    }
}
