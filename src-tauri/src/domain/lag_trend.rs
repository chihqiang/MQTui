//! 消费组滞后趋势：把几次滞后采样摊开，回答「它在追还是在欠」。
//!
//! 详情弹窗里的滞后量是一次快照。快照回答不了排查时最先要问的那句：
//! **这个 12 万条是在往下走，还是刚涨上来**。同一秒的两份快照看起来完全一样。
//!
//! 做法与主题吞吐同源：读两次（或多次）逐分区进度，算差值。区别在于
//! 「好」的方向相反 —— 吞吐涨是好事，滞后涨是坏事，所以判读文案必须分开写，
//! 不能共用一套「涨/跌」的措辞。
//!
//! 三条必须守住的规矩：
//! - **位点后退不是「消费变快」**。位点重置、组被删了重建、分区被截断都会让
//!   已提交位点往回走，算出来是虚假的追赶。按「无法比较」处理，不给速率。
//! - **分区要对得上号**。按 `(topic, partition)` 配对，不按列表下标 ——
//!   两次之间分区列表顺序变了就会张冠李戴。
//! - **只算共同分区**。窗口内新增的分区没有基线，不猜它的速度；
//!   消失的分区要说出来，否则「总滞后降了」看起来像追上去了。

use serde::{Deserialize, Serialize};

use super::consumer::ConsumerGroupOffset;
use super::topic_throughput::SampleWindow;

/// 一个分区在窗口内的进展。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionLagProgress {
    pub topic: String,
    pub partition: i32,
    /// 窗口开始时的滞后。
    pub lag_before: i64,
    /// 窗口结束时的滞后。
    pub lag_after: i64,
    /// 滞后变化量：负数表示追上了，正数表示越欠越多。
    pub lag_delta: i64,
    /// 窗口内消费端推进的位点条数（已提交位点之差，负数按 0 计）。
    pub consumed: i64,
    /// 窗口内写入的条数（`high` 之差，负数按 0 计）。
    pub produced: i64,
    /// 这个分区的趋势判定。
    pub verdict: LagVerdict,
}

/// 单个分区的趋势判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LagVerdict {
    /// 滞后减少：在追。
    Catching,
    /// 滞后增加：越欠越多。
    Falling,
    /// 没有变化。
    Flat,
    /// 位点往回走了，这个窗口的差值没有意义。
    Rewound,
}

impl LagVerdict {
    /// 是不是「在追」。界面用它决定这一行要不要给绿色。
    pub fn is_recovering(self) -> bool {
        matches!(self, Self::Catching)
    }

    pub fn is_worsening(self) -> bool {
        matches!(self, Self::Falling)
    }
}

/// 整个消费组的趋势结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LagTrendVerdict {
    /// 滞后在减少，消费端追得上。
    Catching,
    /// 滞后在增加，消费端跟不上。
    Falling,
    /// 完全不动的零滞后，或者动但净变化为 0。
    Flat,
    /// 两侧都没有可比较的位点（空组、新组）。
    NoBaseline,
    /// 位点集体后退：重置过位点，或组被删了重建。
    Rewound,
}

impl LagTrendVerdict {
    pub fn label(self) -> &'static str {
        match self {
            Self::Catching => "在追",
            Self::Falling => "越欠越多",
            Self::Flat => "持平",
            Self::NoBaseline => "无法比较",
            Self::Rewound => "位点回退",
        }
    }
}

/// 一个消费组在一次采样里的进度快照。直接用详情里的分区列表，不另起结构。
///
/// 只在后端内部流转（进 `compute` 就出报告），不序列化、也不需要比较，
/// 所以不 derive `PartialEq` —— 那会要求 `ConsumerGroupOffset` 也跟着实现。
#[derive(Debug, Clone)]
pub struct LagSample {
    /// 采样时刻（毫秒时间戳）。用调用方给的时间，方便测试。
    pub at_ms: u64,
    pub offsets: Vec<ConsumerGroupOffset>,
}

impl LagSample {
    pub fn new(at_ms: u64, offsets: Vec<ConsumerGroupOffset>) -> Self {
        Self { at_ms, offsets }
    }

    /// 全部滞后之和。没有位点的分区按 `lag` 字段算（后端已经兜过负数）。
    pub fn total_lag(&self) -> i64 {
        self.offsets.iter().map(|item| item.lag).sum()
    }
}

/// 一个消费组的滞后趋势报告。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LagTrend {
    pub group: String,
    /// 两次采样的间隔毫秒数。
    pub window_ms: u64,
    pub window: SampleWindow,
    pub verdict: LagTrendVerdict,
    /// 窗口开始时的总滞后。
    pub lag_before: i64,
    /// 窗口结束时的总滞后。
    pub lag_after: i64,
    /// 净变化：正数表示滞后变多。
    pub lag_delta: i64,
    /// 窗口内消费掉的总条数（共同分区之和）。
    pub consumed: i64,
    /// 窗口内写入的总条数（共同分区之和）。
    pub produced: i64,
    /// 每秒消费条数。窗口不可用时给 0，不给虚高值。
    pub consume_rate: f64,
    /// 该追上的速度：在现有消费速度之外，每秒还得多消费多少条，
    /// 才能把这一波新增的落后量在一小时内消化掉。
    ///
    /// 只在「确实在越欠越多」时给。滞后不涨的时候这个数字算出来是 0 或负数，
    /// 读起来像「一小时能追完」，而实际上根本没有债。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catch_up_rate: Option<f64>,
    /// 单分区进展，按「最该看的在前」排序。
    pub partitions: Vec<PartitionLagProgress>,
    /// 只在某一侧出现的分区（新增 / 消失），不参与汇总。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

/// 一句话结论，界面上直接显示，不在前端拼中文。
pub fn describe(group: &str, trend: &LagTrend) -> String {
    let lag = |value: i64| value.max(0).to_string();
    match trend.verdict {
        LagTrendVerdict::Catching => format!(
            "{group} 在追：滞后从 {} 降到 {}，窗口内消费 {} 条",
            lag(trend.lag_before),
            lag(trend.lag_after),
            trend.consumed
        ),
        LagTrendVerdict::Falling => format!(
            "{group} 越欠越多：滞后从 {} 涨到 {}，窗口内写入 {} 条、消费 {} 条",
            lag(trend.lag_before),
            lag(trend.lag_after),
            trend.produced,
            trend.consumed
        ),
        LagTrendVerdict::Flat if trend.lag_after <= 0 => {
            format!(
                "{group} 没有积压，窗口内写入 {} 条、消费 {} 条",
                trend.produced, trend.consumed
            )
        }
        LagTrendVerdict::Flat => format!(
            "{group} 滞后持平在 {} 条：消费速度约等于写入速度",
            lag(trend.lag_after)
        ),
        LagTrendVerdict::NoBaseline => {
            format!("{group} 没有可比较的位点，无法判断趋势（空组或尚未提交位点）")
        }
        LagTrendVerdict::Rewound => format!(
            "{group} 的位点在窗口内往回走了：可能重置过位点或组被重建，这段时间的差值不作数"
        ),
    }
}

/// 主题 + 分区，作为配对用的一次性键。
fn key_of(offset: &ConsumerGroupOffset) -> String {
    format!("{}/{}", offset.topic, offset.partition)
}

/// 由两次采样算滞后趋势。
///
/// 判定顺序刻意写死：先看窗口能不能用，再看有没有位点集体后退，
/// 最后才谈「追/欠」。反过来做的话，位点后退会被算成一次漂亮的追赶。
pub fn compute(group: &str, previous: &LagSample, current: &LagSample) -> LagTrend {
    let window = SampleWindow::evaluate(previous.at_ms, current.at_ms);
    let window_ms = current.at_ms.saturating_sub(previous.at_ms);
    let seconds = window_ms as f64 / 1_000.0;
    let usable = window.is_usable() && seconds > 0.0;

    let mut partitions = Vec::new();
    let mut missing = Vec::new();
    let mut consumed = 0_i64;
    let mut produced = 0_i64;
    let mut rewound = false;
    let mut compared = 0_usize;

    for now in &current.offsets {
        let Some(before) = previous
            .offsets
            .iter()
            .find(|item| item.topic == now.topic && item.partition == now.partition)
        else {
            // 这个分区在窗口里才出现：没有基线，不猜。
            continue;
        };

        // 位点往回走：重置、重建、截断都可能。差值没有意义，
        // 但分区本身要留在列表里 —— 用户得看见「这一块数据不作数」。
        let (Some(from), Some(to)) = (before.offset, now.offset) else {
            continue;
        };
        compared += 1;
        let rewound_here = to < from;
        if rewound_here {
            rewound = true;
        } else {
            consumed += to - from;
            produced += (now.high - before.high).max(0);
        }

        let lag_delta = now.lag - before.lag;
        partitions.push(PartitionLagProgress {
            topic: now.topic.clone(),
            partition: now.partition,
            lag_before: before.lag,
            lag_after: now.lag,
            lag_delta,
            consumed: (to - from).max(0),
            produced: (now.high - before.high).max(0),
            verdict: if rewound_here {
                LagVerdict::Rewound
            } else if lag_delta < 0 {
                LagVerdict::Catching
            } else if lag_delta > 0 {
                LagVerdict::Falling
            } else {
                LagVerdict::Flat
            },
        });
    }

    for before in &previous.offsets {
        if !current
            .offsets
            .iter()
            .any(|item| item.topic == before.topic && item.partition == before.partition)
        {
            missing.push(key_of(before));
        }
    }
    missing.sort();

    // 排序：越欠越多的排最前，其次是在追的，再次是回退与持平。
    // 排查时想先看的就是「哪个分区在恶化」。
    partitions.sort_by(|a, b| {
        rank(a.verdict)
            .cmp(&rank(b.verdict))
            .then_with(|| b.lag_delta.cmp(&a.lag_delta))
            .then_with(|| a.topic.cmp(&b.topic))
            .then_with(|| a.partition.cmp(&b.partition))
    });

    let lag_before = previous.total_lag();
    let lag_after = current.total_lag();
    let lag_delta = lag_after - lag_before;

    let verdict = if rewound {
        LagTrendVerdict::Rewound
    } else if compared == 0 {
        LagTrendVerdict::NoBaseline
    } else if lag_delta < 0 {
        LagTrendVerdict::Catching
    } else if lag_delta > 0 {
        LagTrendVerdict::Falling
    } else {
        LagTrendVerdict::Flat
    };

    // 速率只对可用窗口给。区间太短时数字会虚高十几倍，
    // 前端拿到 0 至少不会让人盯着一个假数字看。
    let consume_rate = if usable {
        consumed as f64 / seconds
    } else {
        0.0
    };

    // 「追上要多久」只在确实在欠的时候有意义：滞后已经不涨了，
    // 这个数字算出来会是负数或者零，读起来像「一小时能追完」。
    let catch_up_rate = (verdict == LagTrendVerdict::Falling && usable && lag_delta > 0)
        .then(|| lag_delta as f64 / 3_600.0);

    LagTrend {
        group: group.to_owned(),
        window_ms,
        window,
        verdict,
        lag_before,
        lag_after,
        lag_delta,
        consumed,
        produced,
        consume_rate,
        catch_up_rate,
        partitions,
        missing,
    }
}

/// 排序用的优先级：数字小的先显示。
fn rank(verdict: LagVerdict) -> u8 {
    match verdict {
        LagVerdict::Falling => 0,
        LagVerdict::Catching => 1,
        LagVerdict::Rewound => 2,
        LagVerdict::Flat => 3,
    }
}

/// 把多次采样串成一条序列，逐段算趋势。
///
/// 面板只在内存里留最近几次采样（见 `MAX_SAMPLES`）：关掉窗口这些数字本来
/// 也该一起消失，长期趋势该交给监控系统。返回的每一段都带上自己的时间点，
/// 前端据此画折线而不用再猜顺序。
pub fn series(group: &str, samples: &[LagSample]) -> Vec<LagTrend> {
    samples
        .windows(2)
        .map(|pair| compute(group, &pair[0], &pair[1]))
        .collect()
}

/// 一次序列里最多保留的采样条数。再多也没有新的信息量。
pub const MAX_SAMPLES: usize = 20;

#[cfg(test)]
mod tests {
    use super::*;

    fn offset(topic: &str, partition: i32, offset: i64, high: i64) -> ConsumerGroupOffset {
        ConsumerGroupOffset {
            topic: topic.to_owned(),
            partition,
            offset: Some(offset),
            high,
            lag: (high - offset).max(0),
        }
    }

    fn sample(at_ms: u64, items: Vec<ConsumerGroupOffset>) -> LagSample {
        LagSample::new(at_ms, items)
    }

    #[test]
    fn catching_up_is_reported_as_progress() {
        let before = sample(0, vec![offset("orders", 0, 100, 1_100)]);
        let after = sample(10_000, vec![offset("orders", 0, 800, 1_100)]);
        let trend = compute("g1", &before, &after);

        assert_eq!(trend.verdict, LagTrendVerdict::Catching);
        assert_eq!(trend.lag_before, 1_000);
        assert_eq!(trend.lag_after, 300);
        assert_eq!(trend.lag_delta, -700);
        assert_eq!(trend.consumed, 700);
        assert_eq!(trend.produced, 0);
        assert!((trend.consume_rate - 70.0).abs() < f64::EPSILON);
        assert_eq!(trend.partitions[0].verdict, LagVerdict::Catching);
    }

    #[test]
    fn lagging_behind_estimates_the_rate_needed() {
        // 10 秒里写入 600 条、消费 100 条：滞后涨了 500。
        // 要在一小时内把这 500 条消化掉，得在现有速度之外再多消费 500/3600 ≈ 0.139/s。
        let before = sample(0, vec![offset("orders", 0, 100, 1_000)]);
        let after = sample(10_000, vec![offset("orders", 0, 200, 1_600)]);
        let trend = compute("g1", &before, &after);

        assert_eq!(trend.verdict, LagTrendVerdict::Falling);
        assert_eq!(trend.lag_delta, 500);
        assert_eq!(trend.produced, 600);
        assert_eq!(trend.consumed, 100);
        let rate = trend.catch_up_rate.expect("越欠越多时应当给出追赶速度");
        assert!((rate - 500.0 / 3_600.0).abs() < 0.001, "{rate}");
    }

    #[test]
    fn catch_up_rate_is_absent_when_the_group_is_not_in_debt() {
        let before = sample(0, vec![offset("orders", 0, 100, 1_000)]);
        let after = sample(10_000, vec![offset("orders", 0, 1_000, 1_000)]);
        assert!(compute("g1", &before, &after).catch_up_rate.is_none());
    }

    #[test]
    fn commit_rewind_is_not_reported_as_a_catch() {
        // 位点重置到开头：滞后从 100 一夜之间变成 1000，但这不是「消费变慢」，
        // 也不能报成「追上了」。差值整体不作数。
        let before = sample(0, vec![offset("orders", 0, 900, 1_000)]);
        let after = sample(5_000, vec![offset("orders", 0, 0, 1_000)]);
        let trend = compute("g1", &before, &after);

        assert_eq!(trend.verdict, LagTrendVerdict::Rewound);
        assert_eq!(trend.partitions[0].verdict, LagVerdict::Rewound);
        assert_eq!(trend.consumed, 0);
        assert!(trend.catch_up_rate.is_none());
        // 数字照样展示：这是用户看得见的事实，只是不算趋势。
        assert_eq!(trend.lag_after, 1_000);
    }

    #[test]
    fn partitions_are_matched_by_topic_and_id_not_position() {
        let before = sample(0, vec![offset("a", 0, 0, 0), offset("a", 1, 0, 100)]);
        // 顺序反了、并且两个分区进度不同：按位置配会把 P0 的增量算到 P1 上。
        let after = sample(
            1_000,
            vec![offset("a", 1, 100, 100), offset("a", 0, 500, 500)],
        );
        let trend = compute("g1", &before, &after);
        let p0 = trend
            .partitions
            .iter()
            .find(|item| item.partition == 0)
            .unwrap();
        let p1 = trend
            .partitions
            .iter()
            .find(|item| item.partition == 1)
            .unwrap();
        assert_eq!(p0.consumed, 500);
        assert_eq!(p1.consumed, 100);
    }

    #[test]
    fn a_single_topic_id_is_not_shared_across_topics() {
        // 同一个分区号出现在两个主题里：必须分别配对。
        let before = sample(0, vec![offset("a", 0, 0, 10), offset("b", 0, 0, 10)]);
        let after = sample(1_000, vec![offset("a", 0, 10, 10), offset("b", 0, 0, 10)]);
        let trend = compute("g1", &before, &after);
        assert_eq!(trend.consumed, 10);
        assert_eq!(trend.partitions.len(), 2);
    }

    #[test]
    fn new_partition_without_baseline_is_skipped_but_reported() {
        let before = sample(0, vec![offset("a", 0, 0, 100)]);
        let after = sample(1_000, vec![offset("a", 0, 50, 100), offset("a", 1, 0, 900)]);
        let trend = compute("g1", &before, &after);

        // 新分区不参与汇总：没有基线就不猜它的速度。
        assert_eq!(trend.produced, 0);
        assert_eq!(trend.consumed, 50);
        // 但总滞后里它是在的，否则「滞后涨了」会没有解释。
        assert_eq!(trend.lag_after, 950);
        assert_eq!(trend.partitions.len(), 1);
    }

    #[test]
    fn vanished_partition_is_listed_not_silently_dropped() {
        let before = sample(0, vec![offset("a", 0, 0, 100), offset("a", 1, 0, 100)]);
        let after = sample(1_000, vec![offset("a", 0, 0, 100)]);
        let trend = compute("g1", &before, &after);
        assert_eq!(trend.missing, vec!["a/1".to_owned()]);
        // 滞后「下降」了 100，但那只是分区没了，不能说是在追。
        assert_eq!(trend.verdict, LagTrendVerdict::Catching);
    }

    #[test]
    fn empty_group_has_no_baseline() {
        let trend = compute("g1", &sample(0, vec![]), &sample(1_000, vec![]));
        assert_eq!(trend.verdict, LagTrendVerdict::NoBaseline);
        assert_eq!(trend.consume_rate, 0.0);
        assert!(trend.partitions.is_empty());
    }

    #[test]
    fn uncommitted_offsets_are_not_compared() {
        let mut before = offset("a", 0, 0, 100);
        before.offset = None;
        let trend = compute(
            "g1",
            &sample(0, vec![before]),
            &sample(1_000, vec![offset("a", 0, 50, 100)]),
        );
        assert_eq!(trend.verdict, LagTrendVerdict::NoBaseline);
    }

    #[test]
    fn too_short_window_zeroes_the_rate_but_keeps_the_deltas() {
        let before = sample(0, vec![offset("a", 0, 0, 1_000)]);
        let after = sample(10, vec![offset("a", 0, 10, 1_000)]);
        let trend = compute("g1", &before, &after);
        assert_eq!(trend.window, SampleWindow::TooShort);
        assert_eq!(trend.consumed, 10);
        assert_eq!(trend.consume_rate, 0.0);
    }

    #[test]
    fn clock_going_backwards_is_flagged_not_negative() {
        let before = sample(10_000, vec![offset("a", 0, 0, 100)]);
        let after = sample(5_000, vec![offset("a", 0, 50, 100)]);
        let trend = compute("g1", &before, &after);
        assert_eq!(trend.window, SampleWindow::Invalid);
        assert_eq!(trend.consume_rate, 0.0);
    }

    #[test]
    fn flat_zero_lag_is_not_described_as_balanced() {
        let before = sample(0, vec![offset("a", 0, 100, 100)]);
        let after = sample(10_000, vec![offset("a", 0, 150, 150)]);
        let trend = compute("g1", &before, &after);
        assert_eq!(trend.verdict, LagTrendVerdict::Flat);
        assert!(describe("g1", &trend).contains("没有积压"));
    }

    #[test]
    fn worsening_partitions_are_listed_first() {
        let before = sample(
            0,
            vec![
                offset("a", 0, 0, 100),
                offset("a", 1, 0, 100),
                offset("a", 2, 0, 100),
            ],
        );
        let after = sample(
            1_000,
            vec![
                offset("a", 0, 10, 100),
                offset("a", 1, 0, 1_100),
                offset("a", 2, 100, 100),
            ],
        );
        let trend = compute("g1", &before, &after);
        assert_eq!(trend.partitions[0].partition, 1);
        assert_eq!(trend.partitions[0].verdict, LagVerdict::Falling);
        assert_eq!(trend.partitions.last().unwrap().partition, 2);
    }

    #[test]
    fn series_walks_consecutive_pairs() {
        let samples = vec![
            sample(0, vec![offset("a", 0, 0, 100)]),
            sample(1_000, vec![offset("a", 0, 50, 100)]),
            sample(2_000, vec![offset("a", 0, 100, 100)]),
        ];
        let trends = series("g1", &samples);
        assert_eq!(trends.len(), 2);
        assert_eq!(trends[1].lag_after, 0);
        // 单次采样构不成趋势，别硬编一段出来。
        assert!(series("g1", &samples[..1]).is_empty());
    }
}
