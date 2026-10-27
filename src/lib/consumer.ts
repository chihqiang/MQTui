/** 消费组的展示层映射：把 Kafka 的服务端字符串收敛成统一的视觉语言。 */

import type { Tone } from "@/types/tone";

/** Kafka 组状态 → 展示文案与人眼友好的色调。 */
const STATE_MAP: Record<string, { label: string; tone: Tone }> = {
  Stable: { label: "稳定", tone: "success" },
  Empty: { label: "无成员", tone: "neutral" },
  Dead: { label: "已失效", tone: "danger" },
  PreparingRebalance: { label: "重平衡中", tone: "warning" },
  CompletingRebalance: { label: "重平衡收尾", tone: "warning" },
  Assigning: { label: "分配中", tone: "info" },
  Reconciling: { label: "协调中", tone: "info" },
};

/** 未知状态原样透出：新版本 Kafka 加状态时不该被前端吃掉。 */
export function groupState(state: string): { label: string; tone: Tone } {
  return STATE_MAP[state] ?? { label: state || "未知", tone: "neutral" };
}

/**
 * 滞后量的严重程度。
 *
 * 绝对条数阈值比百分比更贴近排查习惯：几百条堆积通常还能自己消化，
 * 上万条基本意味着消费端卡住或掉线了。
 */
export function lagTone(lag: number | undefined): Tone {
  if (lag === undefined) return "neutral";
  if (lag >= 100_000) return "danger";
  if (lag >= 1_000) return "warning";
  if (lag > 0) return "info";
  return "success";
}

/** 滞后量文案：未知时给 `-`，而不是误导性的 0。 */
export function formatLag(lag: number | undefined): string {
  if (lag === undefined) return "-";
  return lag.toLocaleString("zh-CN");
}
