/**
 * 消费组滞后趋势的判读：纯函数，不发请求。
 *
 * 后端已经算好了数字，这里只负责「这个数字该怎么读」。三个不能含糊的地方：
 *
 * 1. **追上是好事，越欠越多是坏事** —— 和主题吞吐的「涨/跌」正好相反。
 *    共用一套措辞就会把「lag 降了」说成「下降了，注意」。
 * 2. **窗口不可用时不谈趋势**。间隔 10 毫秒算出的速率会虚高十几倍，
 *    拿它下结论比不给结论更糟。
 * 3. **位点回退不是追赶**。重置过位点、组被重建，滞后会一夜之间涨回来，
 *    这时任何一个差值都在撒谎。
 */

import type {
  LagTrend,
  LagTrendVerdict,
  LagVerdict,
  PartitionLagProgress,
} from "../types/lag-trend.ts";
import type { SampleWindow } from "../types/topic-throughput.ts";
import type { Tone } from "../types/tone.ts";

/** 趋势结论 → 展示用文案与色调。 */
const VERDICT_MAP: Record<LagTrendVerdict, { label: string; tone: Tone }> = {
  catching: { label: "在追", tone: "success" },
  falling: { label: "越欠越多", tone: "danger" },
  flat: { label: "持平", tone: "neutral" },
  noBaseline: { label: "无法比较", tone: "neutral" },
  rewound: { label: "位点回退", tone: "warning" },
};

/** 趋势结论的展示信息。未知取值不该被吃掉（后端加结论时先显示原文）。 */
export function verdictOf(verdict: string): { label: string; tone: Tone } {
  return VERDICT_MAP[verdict as LagTrendVerdict] ?? { label: verdict || "未知", tone: "neutral" };
}

/** 单分区判定的色调。恶化最显眼，持平最安静。 */
export function verdictTone(verdict: LagVerdict): Tone {
  switch (verdict) {
    case "falling":
      return "danger";
    case "catching":
      return "success";
    case "rewound":
      return "warning";
    default:
      return "neutral";
  }
}

/** 单分区判定的一句话。 */
export function verdictText(verdict: LagVerdict): string {
  switch (verdict) {
    case "falling":
      return "越欠越多";
    case "catching":
      return "在追";
    case "rewound":
      return "位点回退";
    default:
      return "持平";
  }
}

/**
 * 速率文案。
 *
 * `0.004 条/秒` 显示成 `0.00` 会被读成「停了」，所以小到看不见时说清楚，
 * 而不是四舍五入成一个看起来很确定的 0。
 */
export function formatRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return "0 条/秒";
  if (rate < 0.01) return "< 0.01 条/秒";
  if (rate < 1) return `${rate.toFixed(2)} 条/秒`;
  if (rate < 10) return `${rate.toFixed(1)} 条/秒`;
  return `${Math.round(rate).toLocaleString("zh-CN")} 条/秒`;
}

/** 带正负号的条数：`+300` / `-1,200`。变化量不带符号就没有方向。 */
export function formatDelta(delta: number): string {
  const value = delta.toLocaleString("zh-CN");
  if (delta > 0) return `+${value}`;
  return value;
}

/** 窗口提示；可用时返回 `undefined`。 */
export function windowWarning(window: SampleWindow): string | undefined {
  switch (window) {
    case "fresh":
      return undefined;
    case "tooShort":
      return "两次采样挨得太近，趋势跳动较大，多采几次再看";
    case "tooOld":
      return "样本已超过 30 分钟，显示的是那段时间的平均趋势";
    case "invalid":
      return "两次采样的时间顺序不对，本次不计算趋势";
  }
}

/** 趋势能不能当真。只有正常窗口下才敢下结论。 */
export function trendIsTrustworthy(window: SampleWindow): boolean {
  return window === "fresh";
}

/**
 * 一句话结论，放在区块标题旁边。
 *
 * 窗口不可用、位点回退这两种情况必须写在最前面：它们的数字看起来都有意义，
 * 但那正是最容易让人读错的地方。
 */
export function summarize(trend: LagTrend): string {
  const warning = windowWarning(trend.window);
  if (warning) return warning;

  const lag = Math.max(trend.lagAfter, 0).toLocaleString("zh-CN");
  switch (trend.verdict) {
    case "catching":
      return `滞后从 ${Math.max(trend.lagBefore, 0).toLocaleString("zh-CN")} 降到 ${lag}，在追`;
    case "falling":
      return `滞后从 ${Math.max(trend.lagBefore, 0).toLocaleString("zh-CN")} 涨到 ${lag}，越欠越多`;
    case "flat":
      return trend.lagAfter <= 0
        ? "没有积压，写入与消费都跟得上"
        : `滞后持平在 ${lag} 条：消费速度约等于写入速度`;
    case "rewound":
      return "位点在窗口内往回走了，这段时间的差值不作数";
    case "noBaseline":
      return "没有可比较的位点（空组或尚未提交位点）";
  }
}

/** 有没有「越欠越多」的分区。有就说明问题不在全局，而在某几个分区。 */
export function hasWorsening(trend: LagTrend): boolean {
  return trend.partitions.some((item) => item.verdict === "falling");
}

/** 需要单独看一眼的分区：恶化与回退。持平的分区没有信息量。 */
export function notablePartitions(trend: LagTrend): PartitionLagProgress[] {
  return trend.partitions.filter(
    (item) => item.verdict === "falling" || item.verdict === "rewound",
  );
}

/** 一条关于「分区不齐」的提醒：新增/消失的分区不参与汇总，得说出来。 */
export function missingNote(trend: LagTrend): string | undefined {
  const missing = trend.missing ?? [];
  if (!missing.length) return undefined;
  return `分区 ${missing.join("、")} 在本轮采样里已不存在，未计入趋势`;
}

/** 追赶速度的说明；没有这个数字时返回 `undefined`。 */
export function catchUpNote(trend: LagTrend): string | undefined {
  if (trend.catchUpRate === undefined) return undefined;
  return `要在 1 小时内消化新增落后，需在此基础上再快 ${formatRate(trend.catchUpRate)}`;
}
