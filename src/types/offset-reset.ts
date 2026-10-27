/** 与 `src-tauri/src/domain/offset_reset.rs` 一一对应的领域类型。 */

export type ResetTarget = "earliest" | "latest" | "timestamp" | "offset";

export interface PartitionState {
  partition: number;
  /** 从未提交过位点时为 null。 */
  committed: number | null;
  earliest: number;
  latest: number;
}

export interface ResetStep {
  partition: number;
  from: number | null;
  to: number;
  /** 正数 = 会重放这么多条，负数 = 会跳过这么多条。 */
  delta: number;
  /** 位点是否真的变化；false 的分区不会提交。 */
  changed: boolean;
}

export interface ResetPlan {
  target: ResetTarget;
  targetLabel: string;
  steps: ResetStep[];
  replay: number;
  skip: number;
  /** 非空时禁止执行。 */
  blockers: string[];
  notes: string[];
}

export interface ResetPhase {
  order: number;
  title: string;
  detail: string;
}

export interface CommitOutcome {
  group: string;
  topic: string;
  replay: number;
  skip: number;
  /** 计划里需要改动的分区数。 */
  requested: number;
  /** 实际提交的分区数；与 requested 不等说明有分区失效。 */
  committed: number;
}

/**
 * 位点重置的可选目标。
 *
 * 只有两种。精确位点与按时间要用户另输数字或时间戳，输错一个零就从
 * 「重放一天」变成「重放一年」—— 那两个入口等真有需求再加，而且加的时候
 * 也应该是独立的、更重的确认流程。选项表放这里，页面只负责画出来。
 */
export const RESET_TARGETS: readonly { value: ResetTarget; label: string; hint: string }[] = [
  { value: "earliest", label: "最早位点", hint: "重放主题保留的全部分区数据" },
  { value: "latest", label: "末尾位点", hint: "跳过当前全部积压" },
];

/** 对照表的入参：一次重置的全部上下文。 */
export interface ResetPlanCardProps {
  connectionId: string | undefined;
  group: string;
  topic: string;
  plan: ResetPlan;
  phases: { order: number; title: string; detail: string }[];
}


/** 提交确认框的入参。 */
export interface CommitResetModalProps {
  connectionId: string | undefined;
  group: string;
  topic: string;
  plan: ResetPlan;
  open: boolean;
  onClose: () => void;
}

