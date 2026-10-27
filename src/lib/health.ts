/**
 * 健康检查的前端判读。
 *
 * 后端给的是「这台机器允许做什么」的原始条目，这里只回答一个问题：
 * 能不能写。抽成方法而不是留在 `types/health.ts`：types 只放定义。
 */

import { WRITE_ACCESS_KEY, type HealthReport } from "../types/health.ts";

/** 是否允许写操作：只有明确 `ok` 才算通过。 */
export function writeAllowed(report: HealthReport | undefined): boolean {
  return Boolean(
    report?.items.some((item) => item.key === WRITE_ACCESS_KEY && item.status === "ok"),
  );
}
