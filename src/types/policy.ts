/**
 * 与 `src-tauri/src/domain/policy.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

/** 策略生效范围，对应管理 API 的 `apply-to`。 */
export type PolicyApplyTo = "queues" | "exchanges" | "all";

/** 策略定义中的一项，值是渲染后的字符串。 */
export interface DefinitionEntry {
  key: string;
  value: string;
}

export interface PolicyInfo {
  name: string;
  vhost: string;
  pattern: string;
  priority: number;
  applyTo: PolicyApplyTo;
  definition: DefinitionEntry[];
}

/**
 * 操作员策略。与普通策略同形，但用户改不了，只能由运维下发 ——
 * 界面上必须分开，混在一起会让人误以为能随手改掉。
 */
export interface OperatorPolicyInfo {
  name: string;
  vhost: string;
  pattern: string;
  priority: number;
  applyTo: PolicyApplyTo;
  definition: DefinitionEntry[];
}

export interface PolicySnapshot {
  policies: PolicyInfo[];
  operatorPolicies: OperatorPolicyInfo[];
  /** 操作员策略拉取失败的原因（老版本没有该接口）；普通策略不受影响。 */
  operatorError?: string | null;
}

export interface PolicySpec {
  name: string;
  pattern: string;
  priority: number;
  applyTo: PolicyApplyTo;
  definition: DefinitionEntry[];
}

/**
 * 影响面估算的可靠程度。
 *
 * `literal` 之外都说明「这个数字不完全可信」：`complex` 是模式里有字符类 / 转义，
 * `unreadable` 是压根没有可比字面量（此时 `queues` / `exchanges` 是上界）。
 */
export type ImpactConfidence = "literal" | "complex" | "unreadable";

/** 影响面估算。`exact` 恒为 false：命中判定在服务端，这边只给数量级。 */
export interface ImpactEstimate {
  queues: number;
  exchanges: number;
  exact: boolean;
  confidence: ImpactConfidence;
}

export interface PriorityConflict {
  name: string;
  priority: number;
  detail: string;
}

/** 提交前的预览：影响面 + 优先级冲突 + 注意事项。 */
export interface PolicyPreview {
  impact: ImpactEstimate;
  conflicts: PriorityConflict[];
  caveats: string[];
  /** 模式读不准时的说明。缺省表示影响面可信。 */
  patternNote?: string | null;
}

/** 删除前的后果预检。 */
export interface PolicyRemovalPreview {
  /** 删掉后会退回默认的设置项。 */
  caveats: string[];
  /** 同范围里优先级更低、删除后会接替生效的策略。 */
  successors: string[];
}

/** 策略表的列。操作员策略少一列「操作」—— 用户改不了它们。 */
export const POLICY_COLUMNS = [
  { key: "name", label: "名称" },
  { key: "pattern", label: "匹配模式" },
  { key: "applyTo", label: "范围", width: "w-24" },
  { key: "priority", label: "优先级", width: "w-20", align: "right" },
  { key: "definition", label: "定义" },
  { key: "actions", label: "操作", width: "w-32", align: "right" },
] as const;

export const OPERATOR_POLICY_COLUMNS = [
  { key: "name", label: "名称" },
  { key: "pattern", label: "匹配模式" },
  { key: "applyTo", label: "范围", width: "w-24" },
  { key: "priority", label: "优先级", width: "w-20", align: "right" },
  { key: "definition", label: "定义" },
] as const;

/** 生效范围的徽标文案：从选项表推一次。选项在 `lib/policy.ts`（它带说明文案）。 */
export const APPLY_TO_LABEL: Record<PolicyApplyTo, string> = {
  queues: "队列",
  exchanges: "交换机",
  all: "队列 + 交换机",
};
