/**
 * 主题配置项的编辑态：纯函数，不发请求。
 *
 * 校验规则在后端 `domain/topic_config.rs` 里，这里是它的前端影子 —— 只做
 * 「能不能编辑」和「有没有改动」这类界面判断，真正的校验仍以 `preview`
 * 返回的计划为准。两边都写一套完整校验必然会漂移，所以这里刻意写薄。
 */

import type { ConfigLock, ConfigPlan, ConfigPlanItem } from "../types/topic-config.ts";

/** 配置项在编辑表里的一行。`draft` 是用户正在输入的值。 */
export interface ConfigRow {
  key: string;
  /** 当前生效的值；空串表示没有覆盖项（走 broker 默认）。 */
  value: string;
  /** 用户正在输入的值，与 `value` 不同即为「有改动」。 */
  draft: string;
}

/** 配置项交给界面的可编辑性判定。 */
export interface ConfigRowState {
  lock: ConfigLock;
  /** 不能编辑的原因，可直接挂在 title 上。 */
  reason?: string;
  /** 有未保存的改动。 */
  dirty: boolean;
}

/**
 * 已知配置表的前端镜像。
 *
 * 只用来给「不可编辑」的行置灰并写原因。后端表外的配置一律按 `unknown`
 * 拒绝，界面只需要知道它有值但改不了，不需要知道允许的枚举。
 */
const READ_ONLY = new Set(["message.format.version", "partition_count", "replication_factor"]);

/**
 * 可在面板上新增的配置项（后端配置表里可编辑的那部分）。
 *
 * 用途只有一个：给「还没有覆盖项」的配置一个入口。主题详情只返回被改过的项，
 * 所以 `retention.ms` 在没配过的时候压根不在列表里 —— 想让用户能配上它，
 * 得在这里给出候选。顺序按「排查时最常改」排，不是字母序。
 */
export const ADDABLE_CONFIGS: { key: string; label: string }[] = [
  { key: "retention.ms", label: "保留时长（毫秒）" },
  { key: "retention.bytes", label: "保留容量（字节）" },
  { key: "cleanup.policy", label: "清理策略" },
  { key: "max.message.bytes", label: "单条消息上限（字节）" },
  { key: "min.insync.replicas", label: "最小同步副本数" },
  { key: "segment.bytes", label: "日志段大小（字节）" },
  { key: "segment.ms", label: "日志段滚动时长（毫秒）" },
  { key: "message.timestamp.type", label: "时间戳类型" },
  { key: "message.timestamp.difference.max.ms", label: "时间戳偏差上限（毫秒）" },
  { key: "unclean.leader.election.enable", label: "允许非同步副本选主" },
  { key: "compression.type", label: "压缩方式" },
  { key: "file.delete.delay.ms", label: "删除文件延迟（毫秒）" },
  { key: "flush.messages", label: "刷盘间隔（条）" },
  { key: "flush.ms", label: "刷盘间隔（毫秒）" },
];

/** 尚未出现在表格里、可以补上的配置项。 */
export function missingConfigs(rows: ConfigRow[]): { key: string; label: string }[] {
  const existing = new Set(rows.map((row) => row.key));
  return ADDABLE_CONFIGS.filter((item) => !existing.has(item.key));
}

export function lockOf(key: string, internal: boolean): ConfigLock {
  if (internal) return "internal";
  return READ_ONLY.has(key) ? "readOnly" : "editable";
}

/** 原因文案与后端 `ConfigLock::reason` 保持一致，前端不另编一套说法。 */
const REASONS: Record<ConfigLock, string | undefined> = {
  editable: undefined,
  readOnly: "Kafka 不允许在运行时修改这一项，只能在创建主题时指定",
  dangerous: "改动会让 broker 或主题无法正常加载，面板不提供入口",
  internal: "内部主题的配置由 Kafka 独占管理，不允许修改",
  unknown: "不在已知配置表内，可能是新版 Kafka 的配置项或脏数据",
};

/** 由后端返回的配置项 + 本地草稿，算出每一行的界面状态。 */
export function rowState(row: ConfigRow, internal: boolean): ConfigRowState {
  const lock = lockOf(row.key, internal);
  return {
    lock,
    reason: REASONS[lock],
    // 不可编辑的行永远不算「有改动」：它们不会有 draft。
    dirty: lock === "editable" && row.draft !== row.value,
  };
}

/** 收集所有真正改动的行，转成后端 `ConfigChange` 需要的形状。 */
export function collectChanges(rows: ConfigRow[]): { key: string; value: string }[] {
  return rows
    .filter((row) => row.draft !== row.value)
    .map((row) => ({ key: row.key, value: row.draft }));
}

/** 是否有任何未保存改动。 */
export function hasChanges(rows: ConfigRow[]): boolean {
  return rows.some((row) => row.draft !== row.value);
}

/** 值清空即「恢复默认」，界面上要说清楚，否则用户以为填了个空。 */
export function describeValue(value: string): string {
  return value.trim() === "" ? "默认值" : value;
}

/**
 * 计划里的改动项。
 *
 * 后端对空数组不序列化（`skip_serializing_if`），所以 `items` 缺失是正常状态；
 * `plan` 本身也可能是 `null`（确认框关着、或缓存里那一份被清掉了）。
 * 渲染路径上一律走这里，不要直接摸 `plan.items`。
 */
export function planItems(plan: ConfigPlan | null | undefined): ConfigPlanItem[] {
  return plan?.items ?? [];
}

/**
 * 把后端计划渲染成确认框里的一行行文字。
 *
 * 「从什么改成什么」是确认框里唯一必须说清的事：只说「将修改 3 项配置」，
 * 用户没法判断自己是不是填错了一格。
 */
export function describePlan(plan: ConfigPlan | null | undefined): string[] {
  return planItems(plan).map((item) => {
    const before = describeValue(item.previous);
    const after = describeValue(item.value);
    return `${item.key}: ${before} → ${after}`;
  });
}

/** 计划里必须让用户先读到的后果。后端为空时不下发该字段，这里统一兜成空数组。 */
export function planImpacts(plan: ConfigPlan | null | undefined): string[] {
  return plan?.impacts ?? [];
}

/** 计划里是否含「不可回退」的后果。有则确认框要用更强的语气。 */
export function isRisky(plan: ConfigPlan | null | undefined): boolean {
  return planImpacts(plan).length > 0;
}

/** 要提交流的改动：只取 key 与值，计划为空时一个都不交。 */
export function submitChanges(plan: ConfigPlan | null | undefined): { key: string; value: string }[] {
  return planItems(plan).map((item) => ({ key: item.key, value: item.value }));
}
