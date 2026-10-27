//! 主题吞吐：两次水位采样算差分。
//!
//! 主题列表原来只有「分区数 / 副本因子」两个静态数字，详情页也只有累计水位。
//! 累计水位回答不了排查时最先要问的那句：**「它现在是在涨还是在停」**。
//! `10 万条` 可能是刚写完，也可能是三天没人管。
//!
//! 做法刻意做小：读一次逐分区水位，隔一段时间再读一次，相减除以秒数。
//! 不连 JMX、不落盘、不进时序库 —— 面板是本地常驻应用，关掉窗口这些数字
//! 本来也该一起消失。要画长期趋势该上真正的监控系统，不是这里。
//!
//! 两条必须守住的规矩：
//! - **单调性**：`retention` 到期、主题被删重建时水位会往回掉，差值为负，
//!   此时按 0 处理。报「-3/s」比不报更糟 —— 它看起来像个可解释的数字。
//! - **区间**：样本至少隔 `MIN_WINDOW_MS`，否则抖动被放大成噪音；
//!   超过 `MAX_WINDOW_MS` 就明说「样本太旧」，而不是假装它还是即时速率。

use serde::{Deserialize, Serialize};

use super::{KeyValue, PartitionLoad};

/// 采样区间下限（毫秒）。低于它会拿到一堆 0 与虚高的速率。
pub const MIN_WINDOW_MS: u64 = 1_000;

/// 采样区间上限（毫秒）。超过它不再算「当前速率」，界面必须标注。
pub const MAX_WINDOW_MS: u64 = 30 * 60 * 1_000;

/// 单个分区的水位快照。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionWatermark {
    pub partition: i32,
    /// 起始位点。它随 retention 推进，不随写入推进。
    pub low: i64,
    /// 末尾位点。写入即增长，是这个模块唯一真正在用的数字。
    pub high: i64,
}

impl PartitionWatermark {
    pub fn new(partition: i32, low: i64, high: i64) -> Self {
        Self {
            partition,
            low,
            high,
        }
    }

    /// 该分区当前可读的消息条数。
    pub fn messages(&self) -> i64 {
        (self.high - self.low).max(0)
    }
}

impl From<PartitionWatermark> for PartitionLoad {
    fn from(value: PartitionWatermark) -> Self {
        Self::new(value.partition, value.low, value.high)
    }
}

/// 一次采样：某个时刻、某个主题逐分区的位点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicSample {
    /// 采样时刻（毫秒时间戳）。用调用方给的时间，方便测试。
    pub at_ms: u64,
    pub partitions: Vec<PartitionWatermark>,
}

impl TopicSample {
    pub fn new(at_ms: u64, partitions: Vec<PartitionWatermark>) -> Self {
        Self { at_ms, partitions }
    }

    /// 全部末尾位点之和。
    pub fn total_high(&self) -> i64 {
        self.partitions.iter().map(|item| item.high).sum()
    }

    /// 全部可读消息之和。
    pub fn total_messages(&self) -> i64 {
        self.partitions
            .iter()
            .map(PartitionWatermark::messages)
            .sum()
    }
}

/// 采样窗口的判定结果。界面据此决定「这个速率能不能当真」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SampleWindow {
    /// 正常区间，速率可用。
    Fresh,
    /// 两样本挨得太近，抖动会盖过真实速度。
    TooShort,
    /// 样本太旧，速率只能算「那段时间的平均」，不是现在。
    TooOld,
    /// 同一条时间线取不出区间（时钟回拨或同一时刻）。
    Invalid,
}

impl SampleWindow {
    pub fn evaluate(previous_ms: u64, current_ms: u64) -> Self {
        if current_ms <= previous_ms {
            return Self::Invalid;
        }
        let span = current_ms - previous_ms;
        if span < MIN_WINDOW_MS {
            Self::TooShort
        } else if span > MAX_WINDOW_MS {
            Self::TooOld
        } else {
            Self::Fresh
        }
    }

    /// 能不能把速率当真。`TooOld` 也算「能算但旧」，判定交给界面文案。
    pub fn is_usable(self) -> bool {
        matches!(self, Self::Fresh | Self::TooOld)
    }

    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Fresh => None,
            Self::TooShort => Some("两次采样间隔不足 1 秒，速率跳动较大"),
            Self::TooOld => Some("样本已超过 30 分钟，显示的是那段时间的平均速率"),
            Self::Invalid => Some("两次采样的时间顺序不对，无法计算速率"),
        }
    }
}

/// 单个分区的增长率。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionRate {
    pub partition: i32,
    /// 当前消息条数。
    pub messages: i64,
    /// 窗口内写入的消息条数。
    pub delta: i64,
    /// 每秒消息条数。
    pub rate: f64,
}

/// 一个主题的吞吐报告。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicThroughput {
    pub topic: String,
    /// 两次采样相隔的毫秒数。界面显示「近 N 秒」，这里给的就是它。
    pub window_ms: u64,
    pub window: SampleWindow,
    /// 当前可读消息总量。
    pub messages: i64,
    /// 窗口内写入总量。
    pub delta: i64,
    /// 每秒写入条数。
    pub rate: f64,
    /// 只含在本窗口内有增长的分区，按速率倒序。
    pub partitions: Vec<PartitionRate>,
    /// 本次采样里没有、上次采样里有的分区（扩容前的老样本）。
    /// 不参与汇总，但要说一声，否则总数看起来对不上。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<i32>,
    /// 补充说明，可直接展示。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<KeyValue>,
}

/// 由两次采样算吞吐。
///
/// 三个刻意的选择：
/// - 用 `high` 而不是 `high - low`：retention 会推高 `low`，用可读条数算差分
///   会把「老消息被清理」记成「写入变慢」，方向正好反了。
/// - 分区按 `partition` 号对齐而不是按下标：两次采样之间分区数不该变，
///   但真变了（扩容）也只有按号对齐才不会把 P0 的增量记到 P1 头上。
/// - 负增量归零：删了重建、位点被截断都会出现负值，那不是「速率」。
pub fn compute(topic: &str, previous: &TopicSample, current: &TopicSample) -> TopicThroughput {
    let window = SampleWindow::evaluate(previous.at_ms, current.at_ms);
    let window_ms = current.at_ms.saturating_sub(previous.at_ms);
    let seconds = window_ms as f64 / 1_000.0;

    let mut partitions = Vec::new();
    let mut missing = Vec::new();
    let mut delta_total = 0_i64;

    for now in &current.partitions {
        let Some(before) = previous
            .partitions
            .iter()
            .find(|item| item.partition == now.partition)
        else {
            // 这一轮才出现的分区：没有基线，不猜它的速率。
            continue;
        };
        let delta = (now.high - before.high).max(0);
        delta_total += delta;
        if delta == 0 {
            continue;
        }
        partitions.push(PartitionRate {
            partition: now.partition,
            messages: now.messages(),
            delta,
            rate: if seconds > 0.0 {
                delta as f64 / seconds
            } else {
                0.0
            },
        });
    }

    for before in &previous.partitions {
        if !current
            .partitions
            .iter()
            .any(|item| item.partition == before.partition)
        {
            missing.push(before.partition);
        }
    }
    missing.sort_unstable();

    // 速率只对「有意义的窗口」给：区间太短时数字会虚高十几倍，
    // 前端拿到 0 至少不会让人盯着一个假数字看。
    let rate = if window.is_usable() && seconds > 0.0 {
        delta_total as f64 / seconds
    } else {
        0.0
    };

    partitions.sort_by(|a, b| {
        b.rate
            .partial_cmp(&a.rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.partition.cmp(&b.partition))
    });

    let mut notes = Vec::new();
    if let Some(note) = window.note() {
        notes.push(KeyValue::new("window", note));
    }
    if !missing.is_empty() {
        notes.push(KeyValue::new(
            "missing",
            format!(
                "分区 {} 在本轮采样里已不存在，未计入速率",
                missing
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    if delta_total == 0 && window.is_usable() && !current.partitions.is_empty() {
        notes.push(KeyValue::new("idle", "本窗口没有新消息写入"));
    }

    TopicThroughput {
        topic: topic.to_owned(),
        window_ms,
        window,
        messages: current.total_messages(),
        delta: delta_total,
        rate,
        partitions,
        missing,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marks(items: &[(i32, i64, i64)]) -> Vec<PartitionWatermark> {
        items
            .iter()
            .map(|&(partition, low, high)| PartitionWatermark::new(partition, low, high))
            .collect()
    }

    fn throughput(previous: TopicSample, current: TopicSample) -> TopicThroughput {
        compute("orders", &previous, &current)
    }

    #[test]
    fn rate_is_delta_over_seconds() {
        let before = TopicSample::new(0, marks(&[(0, 0, 1000), (1, 0, 1000)]));
        let after = TopicSample::new(2_000, marks(&[(0, 0, 1400), (1, 0, 1000)]));
        let report = throughput(before, after);
        assert_eq!(report.window, SampleWindow::Fresh);
        assert_eq!(report.window_ms, 2_000);
        assert_eq!(report.delta, 400);
        assert!((report.rate - 200.0).abs() < f64::EPSILON);
        // 没有增长的分区不进列表 —— 一张全是 0 的表没人看。
        assert_eq!(report.partitions.len(), 1);
        assert_eq!(report.partitions[0].partition, 0);
    }

    #[test]
    fn retention_is_not_mistaken_for_slow_writes() {
        // 两端位点都往前推：可读条数没变，但确实写了 300 条。
        let before = TopicSample::new(0, marks(&[(0, 0, 1000)]));
        let after = TopicSample::new(1_000, marks(&[(0, 500, 1300)]));
        let report = throughput(before, after);
        assert_eq!(report.delta, 300);
        assert!((report.rate - 300.0).abs() < f64::EPSILON);
        // 可读条数是「此刻」的：500 条被 retention 收走了。
        assert_eq!(report.messages, 800);
    }

    #[test]
    fn truncated_offsets_do_not_produce_negative_rates() {
        // 主题被删了重建、或位点被截断：`high` 往回掉。
        // 报 -300/s 看起来像个正经数字，其实毫无意义。
        let before = TopicSample::new(0, marks(&[(0, 0, 1000)]));
        let after = TopicSample::new(1_000, marks(&[(0, 0, 700)]));
        let report = throughput(before, after);
        assert_eq!(report.delta, 0);
        assert!((report.rate - 0.0).abs() < f64::EPSILON);
        assert!(report.partitions.is_empty());
        assert!(report.notes.iter().any(|item| item.key == "idle"));
    }

    #[test]
    fn partitions_are_matched_by_id_not_position() {
        // 扩容后顺序变了，按号对齐才不会把 P0 的增量记到别人头上。
        let before = TopicSample::new(0, marks(&[(0, 0, 0), (1, 0, 0)]));
        let after = TopicSample::new(1_000, marks(&[(1, 0, 500), (0, 0, 10)]));
        let report = throughput(before, after);
        assert_eq!(report.delta, 510);
        let first = report.partitions[0];
        assert_eq!(first.partition, 1);
        assert_eq!(first.delta, 500);
    }

    #[test]
    fn vanished_partitions_are_called_out() {
        let before = TopicSample::new(0, marks(&[(0, 0, 10), (5, 0, 10)]));
        let after = TopicSample::new(1_000, marks(&[(0, 0, 20)]));
        let report = throughput(before, after);
        assert_eq!(report.missing, vec![5]);
        assert!(report.notes.iter().any(|item| item.key == "missing"));
    }

    #[test]
    fn short_window_drops_the_rate_but_keeps_the_delta() {
        let before = TopicSample::new(1_000, marks(&[(0, 0, 0)]));
        let after = TopicSample::new(1_100, marks(&[(0, 0, 50)]));
        let report = throughput(before, after);
        assert_eq!(report.window, SampleWindow::TooShort);
        assert_eq!(report.delta, 50);
        assert_eq!(report.rate, 0.0);
        assert!(report.notes.iter().any(|item| item.key == "window"));
    }

    #[test]
    fn stale_samples_are_flagged_but_still_computed() {
        let before = TopicSample::new(0, marks(&[(0, 0, 0)]));
        let after = TopicSample::new(MAX_WINDOW_MS + 1, marks(&[(0, 0, 3600)]));
        let report = throughput(before, after);
        assert_eq!(report.window, SampleWindow::TooOld);
        assert!(report.rate > 0.0);
        assert!(report.window.note().is_some());
    }

    #[test]
    fn clock_going_backwards_is_invalid() {
        let before = TopicSample::new(5_000, marks(&[(0, 0, 0)]));
        let after = TopicSample::new(1_000, marks(&[(0, 0, 100)]));
        let report = throughput(before, after);
        assert_eq!(report.window, SampleWindow::Invalid);
        // 增量本身是事实（确实多写了 100 条），但速率不给：分母不可信。
        assert_eq!(report.delta, 100);
        assert_eq!(report.rate, 0.0);
        assert!(!report.window.is_usable());
    }

    #[test]
    fn empty_sample_is_quiet() {
        let report = throughput(
            TopicSample::new(0, Vec::new()),
            TopicSample::new(1_000, Vec::new()),
        );
        assert_eq!(report.rate, 0.0);
        assert!(report.notes.is_empty());
    }

    #[test]
    fn report_serializes_camel_case() {
        let before = TopicSample::new(0, marks(&[(0, 0, 0)]));
        let after = TopicSample::new(1_000, marks(&[(0, 0, 100)]));
        let json = serde_json::to_value(throughput(before, after)).expect("序列化失败");
        assert_eq!(json["windowMs"], 1_000);
        assert_eq!(json["partitions"][0]["delta"], 100);
        assert_eq!(json["window"], "fresh");
    }
}
