/** 与 `src-tauri/src/domain/lag_trend.rs` 一一对应的领域类型。 */

import type { SampleWindow } from "./topic-throughput.ts";

/** 单个分区的趋势判定。 */
export type LagVerdict = "catching" | "falling" | "flat" | "rewound";

/** 整个消费组的趋势结论。 */
export type LagTrendVerdict =
  | "catching"
  | "falling"
  | "flat"
  | "noBaseline"
  | "rewound";

/** 一个分区在窗口内的进展。 */
export interface PartitionLagProgress {
  topic: string;
  partition: number;
  lagBefore: number;
  lagAfter: number;
  /** 负数表示追上了，正数表示越欠越多。 */
  lagDelta: number;
  /** 窗口内消费端推进的位点条数。 */
  consumed: number;
  /** 窗口内写入的条数。 */
  produced: number;
  verdict: LagVerdict;
}

/** 一个消费组的滞后趋势报告。 */
export interface LagTrend {
  group: string;
  /** 两次采样相隔的毫秒数。 */
  windowMs: number;
  window: SampleWindow;
  verdict: LagTrendVerdict;
  lagBefore: number;
  lagAfter: number;
  /** 净变化：正数表示滞后变多。 */
  lagDelta: number;
  consumed: number;
  produced: number;
  /** 每秒消费条数。窗口不可用时为 0。 */
  consumeRate: number;
  /** 额外需要的每秒消费量（一小时消化掉新增落后）。只在越欠越多时给出。 */
  catchUpRate?: number;
  partitions: PartitionLagProgress[];
  /** 只在某一侧出现的分区（`topic/partition`），不参与汇总。 */
  missing?: string[];
}

/** 趋势采样的可选间隔，与后端 `normalize_window` 的允许范围一致。 */
export const LAG_TREND_WINDOWS: { label: string; ms: number }[] = [
  { label: "3 秒", ms: 3_000 },
  { label: "5 秒", ms: 5_000 },
  { label: "10 秒", ms: 10_000 },
  { label: "30 秒", ms: 30_000 },
];

/** 默认采样间隔。 */
export const LAG_TREND_DEFAULT_WINDOW_MS = 5_000;

/** 分区趋势表格的列定义。 */
export const LAG_PROGRESS_COLUMNS = [
  { key: "partition", label: "分区" },
  { key: "lagBefore", label: "窗口前" },
  { key: "lagAfter", label: "此刻" },
  { key: "delta", label: "变化" },
  { key: "consumed", label: "消费" },
] as const;
