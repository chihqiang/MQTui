/** 与 `src-tauri/src/domain/reassignment.rs` 一一对应的领域类型。 */

export interface PlannedPartition {
  partition: number;
  /** 目标副本所在的 broker id，顺序即副本顺序。 */
  replicas: number[];
}

export interface ReassignmentPlan {
  topic: string;
  partitions: PlannedPartition[];
}

/** 计划校验结果。 */
export interface PlanCheck {
  ok: boolean;
  plan?: ReassignmentPlan;
  /** 校验失败的原因，可直接展示。 */
  reason?: string;
  /** 集群里的 broker 列表，界面上列出来，用户不用猜 id。 */
  brokers: number[];
  topicExists: boolean;
}

export type PartitionMigration = "done" | "syncing" | "pending" | "unknown";

export interface PartitionProgress {
  partition: number;
  state: PartitionMigration;
  target: number[];
  current: number[];
  /** 还需搬过去、当前不在副本列表里的 broker。 */
  missing: number[];
  /** 迁移完成后应当移除的 broker。 */
  extra: number[];
}

export interface MigrationReport {
  topic: string;
  partitions: PartitionProgress[];
  done: number;
  running: number;
  unknown: number;
  /** 后端给出的结论，界面照抄即可。 */
  verdict: string;
}

export const MIGRATION_LABEL: Record<PartitionMigration, string> = {
  done: "已完成",
  syncing: "同步中",
  pending: "待迁移",
  unknown: "计划外分区",
};

/** 迁移前置检查状态。`warn` 不会挡住流程，`block` 会。 */
export type PreconditionState = "ok" | "warn" | "block" | "unknown";

export interface Precondition {
  key: string;
  title: string;
  state: PreconditionState;
  detail: string;
}

/** 一份执行方案：脚本 + 前置检查 + 收尾动作。 */
export interface MigrationRunbook {
  topic: string;
  preconditions: Precondition[];
  /** 为 `false` 时不该让人复制脚本。 */
  actionable: boolean;
  generateScript: string;
  executeScript: string;
  verifyScript: string;
  followups: string[];
}

export type VerifyState = "completed" | "inProgress" | "failed" | "unknown";

export interface VerifyLine {
  partition: string;
  state: VerifyState;
  raw: string;
}

export interface VerifySummary {
  completed: number;
  inProgress: number;
  failed: number;
  lines: VerifyLine[];
  verdict: string;
}

/** `--verify` 解析结果 + 与元数据进度的一致性说明。 */
export interface VerifyResult {
  summary: VerifySummary;
  notes: string[];
}

export const VERIFY_LABEL: Record<VerifyState, string> = {
  completed: "已完成",
  inProgress: "进行中",
  failed: "失败",
  unknown: "未识别",
};

/** 分区迁移进度的状态色。 */
export const MIGRATION_TONE: Record<PartitionMigration, "success" | "warning" | "danger"> = {
  done: "success",
  syncing: "warning",
  pending: "warning",
  unknown: "danger",
};

/**
 * 前置检查的状态色。
 *
 * `block` 用危险色不是「不好看」：它挡住的是不可逆的迁移。
 * `unknown` 用提示色而不是绿色 —— 没读到不等于通过。
 */
export const PRECONDITION_TONE: Record<PreconditionState, "success" | "warning" | "danger" | "info"> = {
  ok: "success",
  warn: "warning",
  block: "danger",
  unknown: "info",
};

/** 校验结果的状态色。`unknown` 同理：读不到不能当通过。 */
export const VERIFY_TONE: Record<VerifyState, "success" | "warning" | "danger" | "info"> = {
  completed: "success",
  inProgress: "warning",
  failed: "danger",
  unknown: "info",
};
