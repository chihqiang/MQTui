//! 「无消费组主题」的领域模型：只统计有堆积却没有任何消费组认领的分区。

use serde::{Deserialize, Serialize};

/// 一个未被消费的分区。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanPartition {
    pub partition: i32,
    /// 分区最早可读位点。老于它的消息已被 retention 清掉，读不回来了。
    pub low: i64,
    /// 分区末尾位点。
    pub high: i64,
    /// 这个分区当前积压的条数，即 `high - low`。
    ///
    /// 单列一个字段而不是让前端自己减：它是这一屏唯一的结论性数字，
    /// 而「末尾位点」看起来太像一个条数，容易被当成堆积量直接相加。
    pub backlog: i64,
}

/// 一个存在未消费分区的主题。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanTopic {
    pub topic: String,
    /// 未被消费的分区数。
    pub partitions: usize,
    /// 未被消费的消息总量（各分区可读区间之和）。
    pub messages: i64,
    /// 未消费分区明细。
    pub detail: Vec<OrphanPartition>,
}

/// 扫描范围。
///
/// 全量扫描要把「所有主题 × 所有分区」逐个问水位，分区上万时是几十秒的事，
/// 而排查时目标往往就几个主题。所以把范围显式化：用户先在候选列表里挑，
/// 再只对这些主题取水位。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanScanScope {
    /// 精确指定的主题名。优先于前缀匹配，两者都为空时才回退到全量。
    #[serde(default)]
    pub topics: Vec<String>,
    /// 主题前缀。`order.` 可一次覆盖一整批同类主题。
    #[serde(default)]
    pub prefix: String,
}

impl OrphanScanScope {
    /// 是否声明了明确的扫描范围。
    pub fn is_targeted(&self) -> bool {
        !self.topics.is_empty() || !self.prefix.trim().is_empty()
    }

    /// 按范围从全部候选主题里筛出要扫描的那些。
    ///
    /// 两者同时给出时取并集：用户填了前缀又勾了几个主题，本意通常是「这些都要看」。
    /// 注意 `topics` 不做前缀匹配——填了完整名字却连带扫出一批同前缀主题会很意外。
    pub fn select<'a>(&self, available: impl IntoIterator<Item = &'a str>) -> Vec<String> {
        let prefix = self.prefix.trim();
        let mut selected: Vec<String> = available
            .into_iter()
            .filter(|name| {
                self.topics.iter().any(|item| item == name)
                    || (!prefix.is_empty() && name.starts_with(prefix))
            })
            .map(str::to_owned)
            .collect();
        selected.sort();
        selected.dedup();
        selected
    }

    /// 未声明范围时的描述，用于返回给前端做提示。
    pub fn describe(&self) -> String {
        if !self.topics.is_empty() && !self.prefix.trim().is_empty() {
            return format!("{} 个主题 + 前缀 {}", self.topics.len(), self.prefix.trim());
        }
        if !self.topics.is_empty() {
            return format!("{} 个指定主题", self.topics.len());
        }
        if !self.prefix.trim().is_empty() {
            return format!("前缀 {}", self.prefix.trim());
        }
        "全量扫描".to_owned()
    }
}

/// 分页结果。数据量小，用 offset 语义而非游标，前端回传更简单。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanTopicPage {
    pub items: Vec<OrphanTopic>,
    pub total: usize,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
    /// 本次实际扫描的主题数。全量扫描很慢，界面需要把「扫了多少」说清楚。
    #[serde(default)]
    pub scanned_topics: usize,
    /// 若用户选的主题在集群里已不存在，列出来提醒，而不是静默忽略。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_topics: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_serializes_camel_case() {
        let page = OrphanTopicPage {
            items: vec![OrphanTopic {
                topic: "orders".to_owned(),
                partitions: 1,
                messages: 42,
                detail: vec![OrphanPartition {
                    partition: 0,
                    low: 0,
                    high: 42,
                    backlog: 42,
                }],
            }],
            total: 1,
            has_more: false,
            next_offset: None,
            scanned_topics: 1,
            missing_topics: Vec::new(),
        };
        let json = serde_json::to_value(&page).expect("序列化失败");
        assert_eq!(json["items"][0]["detail"][0]["high"], 42);
        assert_eq!(json["items"][0]["detail"][0]["backlog"], 42);
        assert!(json.get("nextOffset").is_none());
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    fn scope(topics: &[&str], prefix: &str) -> OrphanScanScope {
        OrphanScanScope {
            topics: topics.iter().map(|item| item.to_string()).collect(),
            prefix: prefix.to_owned(),
        }
    }

    #[test]
    fn empty_scope_is_not_targeted() {
        assert!(!scope(&[], "").is_targeted());
        assert!(!scope(&[], "   ").is_targeted());
        assert!(scope(&["orders"], "").is_targeted());
        assert!(scope(&[], "order.").is_targeted());
    }

    #[test]
    fn select_matches_exact_topics_and_prefix() {
        let available = [
            "orders.created",
            "orders.paid",
            "payments",
            "__consumer_offsets",
        ];
        assert_eq!(
            scope(&["payments"], "orders.").select(available.iter().copied()),
            ["orders.created", "orders.paid", "payments"]
        );
    }

    #[test]
    fn select_dedups_when_topic_matches_prefix() {
        assert_eq!(
            scope(&["orders.created"], "orders.").select(["orders.created"].iter().copied()),
            ["orders.created"]
        );
    }

    #[test]
    fn select_ignores_prefix_on_exact_match() {
        assert_eq!(
            scope(&["payments"], "").select(["payments", "payment"].iter().copied()),
            ["payments"]
        );
    }

    #[test]
    fn select_returns_empty_when_nothing_matches() {
        assert!(
            scope(&["nope"], "nope.")
                .select(["orders"].iter().copied())
                .is_empty()
        );
    }

    #[test]
    fn describe_is_readable() {
        assert_eq!(scope(&[], "").describe(), "全量扫描");
        assert_eq!(scope(&["a", "b"], "").describe(), "2 个指定主题");
        assert_eq!(scope(&[], "order.").describe(), "前缀 order.");
        assert_eq!(scope(&["a"], "order.").describe(), "1 个主题 + 前缀 order.");
    }
}
