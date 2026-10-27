/** 与 `src-tauri/src/domain/topic_config.rs` 一一对应的类型。 */

/** 配置项的可编辑性。布尔值表达不了「为什么不能改」。 */
export type ConfigLock = "editable" | "readOnly" | "dangerous" | "internal" | "unknown";

/** 一次配置项修改。`value` 为空串表示恢复默认值。 */
export interface ConfigChange {
  key: string;
  value: string;
}

/** 一条可提交的改动：校验后的值 + 改动前后 + 后果说明。 */
export interface ConfigPlanItem {
  key: string;
  /** 校验并规整后的值；空串表示恢复默认值。 */
  value: string;
  /** 原先的值。 */
  previous: string;
  /** 这项改动的后果；无副作用时缺失。 */
  impact?: string;
}

/** 批量改配置的计划，由后端纯函数 `plan_config_changes` 生成。 */
export interface ConfigPlan {
  topic: string;
  items: ConfigPlanItem[];
  /** 提交前必须让用户读到的后果汇总。 */
  impacts?: string[];
}

/**
 * 版本兼容性判定。`unknown` 与 `unsupported` 必须分开：
 * 前者是「读不到集群版本」，界面放行并说明；后者是「确定不支持」，拦下。
 */
export type VersionVerdict = "supported" | "unsupported" | "unknown";

export interface ConfigVersionCheck {
  name: string;
  verdict: VersionVerdict;
  /** 该配置项引入的版本；不在版本表里时缺失。 */
  since?: string;
  /** 一行可直接展示的说明。 */
  message: string;
}

export interface ConfigCompatReport {
  /** 集群版本原文；读不到时缺失。 */
  clusterVersion?: string;
  ok: boolean;
  items: ConfigVersionCheck[];
}

/** 配置预览：修改计划 + 版本体检。两者同属一个确认框，一次返回。 */
export interface ConfigPreview {
  plan: ConfigPlan;
  compat: ConfigCompatReport;
}

/** 改配置的结果。 */
export interface ConfigOutcome {
  topic: string;
  applied: string[];
  detail: string;
}
