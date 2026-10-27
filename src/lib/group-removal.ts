/**
 * 删除消费组的预检文案与键。
 *
 * 判定规则在后端（`domain::group_removal`），这里只做两件事：
 * 把一批组名压成一个稳定的缓存键，把预检结果翻译成确认框里能读的话。
 *
 * 为什么值得单独一层：确认框是这个功能唯一露面的地方，而它最容易说错话 ——
 * 「3 个组可以删」和「没看出问题」在运维眼里是两件事。
 */

import type { GroupRemovalCheck, GroupRemovalPreflight } from "@/services/consumer-service";

/** 一批组名的稳定键：去空白、去重、排序。与后端的规范化规则一致。 */
export function groupRemovalKey(groups: string[]): string {
  const names = groups
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
  return [...new Set(names)].sort().join("\u0000");
}

/** 会被服务端拒绝的组。 */
export function blockedChecks(
  preflight: GroupRemovalPreflight | undefined,
): GroupRemovalCheck[] {
  return (preflight?.groups ?? []).filter((check) => check.blocked);
}

/** 没看出问题的组。 */
export function clearChecks(
  preflight: GroupRemovalPreflight | undefined,
): GroupRemovalCheck[] {
  return (preflight?.groups ?? []).filter((check) => !check.blocked);
}

/**
 * 成员数怎么写。
 *
 * `null` 是「读不到」，不是 0 —— 把两者写成同一个数字，就等于把
 * 「我不知道」说成了「没人」。
 */
export function memberText(check: GroupRemovalCheck): string {
  if (check.members === null) return "成员数读不到";
  if (check.members === 0) return "无在线成员";
  return `${check.members} 个在线成员`;
}

/**
 * 一条预检结论的标签色。
 *
 * 只有「确定会被拒绝」才用危险色：读不到成员时给灰色，
 * 否则一个权限问题会让确认框看起来像出了事故。
 */
export function checkTone(check: GroupRemovalCheck): "danger" | "neutral" {
  return check.blocked ? "danger" : "neutral";
}

/**
 * 确认框里的那一句话。
 *
 * 预检失败时不能借用后端的 headline（那说的是「读到的东西」），
 * 得明说是预检本身没成 —— 否则用户会读到一句没有主语的结论。
 */
export function preflightHeadline(
  preflight: GroupRemovalPreflight | undefined,
  failed: boolean,
): string {
  if (failed) return "预检没做成，无法提前说明后果；删除结果以服务端回执为准";
  if (!preflight) return "正在检查这些组能不能删…";
  return preflight.headline;
}

/**
 * 删除按钮该不该按。
 *
 * 只拦「确定会被拒绝」的组：全部组都被占着时按钮禁用，
 * 否则允许按下 —— 服务端会逐组回执，部分成功本来就是常态。
 */
export function canSubmit(preflight: GroupRemovalPreflight | undefined): boolean {
  if (!preflight) return true;
  const checks = preflight.groups;
  if (checks.length === 0) return true;
  return checks.some((check) => !check.blocked);
}
