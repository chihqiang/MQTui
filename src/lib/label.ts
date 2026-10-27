/**
 * 选项表的映射工具。选项本身是数据（在 `types/`），把它们压成「值 → 文案」
 * 是一步计算，所以在这里。
 */

import type { LabelOption } from "../types/label.ts";

/** 从选项表里取出「值 → 文案」的映射，用于徽标、表格单元这类只显示一行字的地方。 */
export function labelOf<T extends string>(options: readonly LabelOption<T>[]): Record<T, string> {
  return Object.fromEntries(options.map((option) => [option.value, option.label])) as Record<T, string>;
}
