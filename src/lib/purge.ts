/**
 * 主题写操作的判读：纯函数，不发请求。
 *
 * 后端已经算好了计划，这里只负责「这份计划该怎么读」：
 * 条数怎么说、时间戳怎么校验、确认框里该让用户看见什么。
 * 判定口径与 `src-tauri/src/domain/topic_purge.rs` 保持一致，改一边记得改另一边。
 */

import type { PurgePlan, PurgeRequest } from "../types/topic-purge.ts";

/** 允许的时钟偏差：本机与集群不同步是常态，一分钟内都放行。 */
const CLOCK_SKEW_MS = 60_000;

/**
 * 把界面上填的时间转成毫秒时间戳。
 *
 * 只接受 `datetime-local` 的本地时间格式（`2024-05-06T12:30`）。
 * 空串与非法值都返回 `undefined` —— 让后端去报「必须给出截止时间」，
 * 而不是在这里造一个 `NaN` 传出去。
 */
export function parseBoundary(text: string): number | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp) ? stamp : undefined;
}

/**
 * 时间戳的本地校验：明显填错时不必等后端往返。
 *
 * 只拦「秒级时间戳」这种量级的错误：它会把整个主题清空，
 * 而后端返回的同一句错误要等一次网络往返才到。
 */
export function checkBoundary(
  before: number | undefined,
  now: number,
): string | undefined {
  if (before === undefined) return "请填写截止时间";
  if (before <= 0) return "截止时间必须是一个正数时间戳";
  if (before > now + CLOCK_SKEW_MS) {
    return "截止时间在未来，这会把整个主题清空；请确认填的是毫秒时间戳";
  }
  return undefined;
}

/** 计划里真正会删掉的条数文案。 */
export function removedText(plan: PurgePlan): string {
  if (plan.removed <= 0) return "没有消息会被删除";
  return `将删除 ${plan.removed.toLocaleString("zh-CN")} 条消息`;
}

/** 覆盖范围文案：明确「动几个分区」，因为只清一部分是最常见的误操作。 */
export function scopeText(plan: PurgePlan): string {
  if (plan.blocked) return "当前计划不可提交";
  return `涉及 ${plan.partitions.length} 个分区`;
}

/**
 * 确认框里必须逐条展示的后果。
 *
 * 后端给的 `notes` 是事实清单，这里再补一条「不可逆」：
 * 它是用户按下按钮前唯一必须理解的一句话，不能藏在说明文字中间。
 */
export function confirmNotes(plan: PurgePlan): string[] {
  return ["删除不可逆：被删的消息无法恢复（只能靠备份或重放上游生产）", ...plan.notes];
}

/** 计划是否可提交。 */
export function canSubmit(plan: PurgePlan | undefined): plan is PurgePlan {
  return Boolean(plan) && !plan?.blocked && (plan?.partitions.length ?? 0) > 0;
}

/** 组装请求：只带后端用得上的字段。 */
export function buildRequest(
  topic: string,
  kind: PurgeRequest["kind"],
  before: number | undefined,
  partitions: number[],
): PurgeRequest {
  return {
    topic,
    kind,
    // 去重不是洁癖：同一个分区发两次，后端会为它发两次删除请求，
    // 第二次必然落在已经推过的低位点上，回执里就会出现一条「失败」。
    partitions: [...new Set(partitions)].sort((a, b) => a - b),
    ...(kind === "deleteBefore" && before !== undefined ? { before } : {}),
  };
}
