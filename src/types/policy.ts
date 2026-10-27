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

/** 影响面估算。`exact` 恒为 false：命中判定在服务端，这边只给数量级。 */
export interface ImpactEstimate {
  queues: number;
  exchanges: number;
  exact: boolean;
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
}
