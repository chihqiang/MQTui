//! 主题列表的分区热点视图。
//!
//! 主题列表原来只有「分区数 / 副本因子」两个数字。它在排查时几乎没用：
//! 一个 12 分区的主题，可能 11 个分区是空的、1 个分区扛着全部流量——
//! 从「12 个分区」这个数字上完全看不出来，而这恰恰是「消费跟不上」的根因。
//!
//! 这一层只做汇总与判定，不碰网络：分区水位由调用方取好之后送进来。

use serde::{Deserialize, Serialize};

/// 单个分区的消息量（由水位算出）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartitionLoad {
    pub partition: i32,
    /// 该分区的消息条数（`high - low`，不会为负）。
    pub messages: i64,
}

impl PartitionLoad {
    pub fn new(partition: i32, low: i64, high: i64) -> Self {
        Self {
            partition,
            messages: (high - low).max(0),
        }
    }
}

/// 热点程度的判定阈值。
///
/// 两个条件必须同时成立才算热点：
/// - **绝对量**：分区至少要有 `MIN_MESSAGES` 条消息，否则「3 个分区里 1 个有 2 条」
///   也会被算成集中，纯属噪音；
/// - **占比**：该分区占主题总量的比例超过「完全均匀时单分区应占比例的 `RATIO` 倍」。
///
/// 用相对均分值的倍数而不是固定百分比，是因为分区的「应得份额」本身随分区数变化：
/// 4 个分区时均分是 25%，16 个分区时均分只有 6.25%，同一个阈值放在两种主题上
/// 会得出完全相反的结论。
pub const MIN_MESSAGES: i64 = 100;
pub const RATIO: f64 = 2.5;

/// 主题的分区分布。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionSpread {
    pub topic: String,
    /// 分区总数。
    pub partitions: usize,
    /// 全部消息总量。
    pub messages: i64,
    /// 消息最多的那个分区的消息数。
    pub max_messages: i64,
    /// 消息最多的分区号；全空主题为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hottest: Option<i32>,
    /// 空分区数量。空分区说明 key 分布不均或写入稀疏。
    pub empty: usize,
    /// 是否判定为热点。
    pub hotspot: bool,
    /// 判定说明，`hotspot` 为假时也可能有内容（例如「分区全部为空」）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl PartitionSpread {
    /// 热点的绝对条数下限。
    pub fn is_hot(&self) -> bool {
        self.hotspot
    }
}

/// 汇总一个主题的分区分布。
pub fn summarize(topic: &str, loads: &[PartitionLoad]) -> PartitionSpread {
    let partitions = loads.len();
    let messages: i64 = loads.iter().map(|item| item.messages).sum();
    let empty = loads.iter().filter(|item| item.messages == 0).count();

    let hottest = loads.iter().max_by(|a, b| {
        a.messages
            .cmp(&b.messages)
            .then_with(|| b.partition.cmp(&a.partition))
    });

    let max_messages = hottest.map_or(0, |item| item.messages);
    // 全空主题没有「最热分区」可言，给 0 会让人以为分区 0 特殊。
    let hottest_partition = hottest
        .filter(|item| item.messages > 0)
        .map(|item| item.partition);

    // 单分区主题：没有「分布不均」这回事，永远不算热点。
    let mut hotspot = false;
    let mut note = None;
    if partitions > 1 && messages > 0 {
        let share = max_messages as f64 / messages as f64;
        let even = 1.0 / partitions as f64;
        // 用 `>` 而不是 `>=`：恰好等于阈值时是「临界均匀」，不该报警。
        // 这条规则也让浮点比较不至于卡在 3 × (1/3) 这种自己算出来的边界上。
        if max_messages >= MIN_MESSAGES && share > even * RATIO {
            hotspot = true;
            note = Some(format!(
                "分区 {} 承载 {:.0}% 的消息（{} 条），均匀分布时应约为 {:.0}%",
                hottest_partition.unwrap_or_default(),
                share * 100.0,
                max_messages,
                even * 100.0
            ));
        }
    }
    if messages == 0 && partitions > 0 {
        note = Some("所有分区都为空".to_owned());
    } else if empty > 0 && note.is_none() {
        note = Some(format!("{empty} 个分区为空"));
    }

    PartitionSpread {
        topic: topic.to_owned(),
        partitions,
        messages,
        max_messages,
        hottest: hottest_partition,
        empty,
        hotspot,
        note,
    }
}

/// 挑出热点主题并按「偏离均分的程度」倒序排列。
///
/// 排序用「最热分区占比 / 均分占比」这个比值，而不是绝对的 `max_messages`：
/// 一个 3 分区主题里某分区占 90%，比一个 64 分区主题里某分区有 5 万条更值得先看。
pub fn hotspots(items: &[PartitionSpread]) -> Vec<PartitionSpread> {
    let mut picked: Vec<PartitionSpread> =
        items.iter().filter(|item| item.hotspot).cloned().collect();
    picked.sort_by(|a, b| {
        let ratio = |item: &PartitionSpread| -> f64 {
            if item.partitions == 0 || item.messages == 0 {
                return 0.0;
            }
            (item.max_messages as f64 / item.messages as f64) * item.partitions as f64
        };
        ratio(b)
            .partial_cmp(&ratio(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.messages.cmp(&a.messages))
            .then_with(|| a.topic.cmp(&b.topic))
    });
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(partition: i32, messages: i64) -> PartitionLoad {
        PartitionLoad::new(partition, 0, messages)
    }

    #[test]
    fn single_partition_is_never_a_hotspot() {
        let spread = summarize("orders", &[load(0, 1_000_000)]);
        assert_eq!(spread.partitions, 1);
        assert!(!spread.hotspot);
        assert!(spread.note.is_none());
    }

    #[test]
    fn evenly_spread_is_not_a_hotspot() {
        let spread = summarize("orders", &[load(0, 1000), load(1, 980), load(2, 1020)]);
        assert!(!spread.hotspot);
        assert_eq!(spread.hottest, Some(2));
        assert_eq!(spread.empty, 0);
    }

    #[test]
    fn skewed_partition_is_flagged_with_ratio_in_note() {
        let spread = summarize(
            "orders",
            &[load(0, 9000), load(1, 500), load(2, 500), load(3, 0)],
        );
        assert!(spread.hotspot);
        assert_eq!(spread.hottest, Some(0));
        assert_eq!(spread.empty, 1);
        let note = spread.note.expect("缺少说明");
        assert!(note.contains("分区 0"), "{note}");
        assert!(note.contains("90%"), "{note}");
    }

    #[test]
    fn small_traffic_is_not_flagged_even_if_skewed() {
        // 3 个分区里 1 个有 5 条：占比 100%，但绝对值太小，属于噪音。
        let spread = summarize("audit", &[load(0, 5), load(1, 0), load(2, 0)]);
        assert!(!spread.hotspot);
        // 分区数越多，「应得份额」越小，阈值自动跟着收紧。
        assert!(!summarize("audit", &[load(0, 60), load(1, 0), load(2, 0)]).hotspot);
        assert!(spread.note.expect("缺少说明").contains("2 个分区为空"));
    }

    #[test]
    fn threshold_scales_with_partition_count() {
        // 16 个分区，均分应为 6.25%；某分区占 25%（4 倍均分）→ 热点。
        let mut loads: Vec<PartitionLoad> = (0..16).map(|index| load(index, 1000)).collect();
        loads[0] = load(0, 6000);
        let spread = summarize("wide", &loads);
        assert!(spread.hotspot);

        // 同样的 25% 放在 4 个分区上（均分 25%）就是均匀分布，不该报警。
        let spread = summarize(
            "narrow",
            &[load(0, 1000), load(1, 1000), load(2, 1000), load(3, 1000)],
        );
        assert!(!spread.hotspot);
    }

    #[test]
    fn empty_topic_reports_medata_only() {
        let spread = summarize("empty", &[load(0, 0), load(1, 0)]);
        assert_eq!(spread.messages, 0);
        assert_eq!(spread.empty, 2);
        assert_eq!(spread.hottest, None);
        assert!(!spread.hotspot);
        assert_eq!(spread.note.as_deref(), Some("所有分区都为空"));
    }

    #[test]
    fn negative_watermarks_are_clamped() {
        // retention 回退时 high < low，消息数不能是负数。
        let item = PartitionLoad::new(0, 500, 100);
        assert_eq!(item.messages, 0);
    }

    #[test]
    fn hotspots_are_sorted_by_deviation_from_even() {
        // narrow：最热分区占 90%（2.7 倍均分，超过 2.5 倍阈值）；两个冷分区各 500 条。
        let narrow = summarize("narrow", &[load(0, 9000), load(1, 500), load(2, 500)]);
        let wide = summarize(
            "wide",
            &[
                load(0, 8000),
                load(1, 1000),
                load(2, 1000),
                load(3, 1000),
                load(4, 1000),
                load(5, 0),
            ],
        );
        // wide 的最热分区占 66.7%（4 倍均分），narrow 占 90%（2.7 倍均分），两者都是热点；
        // 排序按倍数，narrow 反而排后——热度不看绝对条数。
        assert!(
            narrow.hotspot && wide.hotspot,
            "narrow={narrow:?} wide={wide:?}"
        );
        let ranked = hotspots(&[narrow, wide]);
        assert_eq!(
            ranked
                .iter()
                .map(|item| item.topic.as_str())
                .collect::<Vec<_>>(),
            ["wide", "narrow"]
        );
    }

    #[test]
    fn non_hotspots_are_filtered_out() {
        let healthy = summarize("ok", &[load(0, 1000), load(1, 1000)]);
        assert!(hotspots(&[healthy]).is_empty());
    }
}
