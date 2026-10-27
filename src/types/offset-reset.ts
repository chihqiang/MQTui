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
