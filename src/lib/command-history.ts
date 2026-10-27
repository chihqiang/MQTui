/**
 * 命令面板的「最近使用」。
 *
 * 面板打开时如果只按固定顺序列全部命令，用久了每次都要在十几项里找同一个。
 * 记下最近点过的几条并置顶，等于让高频路径自己浮上来。
 *
 * 这里只放纯函数；存取留在 `hooks/use-command-palette.ts`，因为前端单测用
 * `node --test` 直接跑，带 `@/` 别名的导入在那里解析不了。
 */

/** 只留 5 条：再多就把「最近」变成了第二份菜单。 */
export const MAX_RECENT_COMMANDS = 5;

/** 把一条命令顶到最前，去掉重复并裁到上限。 */
export function pushRecent(recent: string[], id: string): string[] {
  return [id, ...recent.filter((item) => item !== id)].slice(0, MAX_RECENT_COMMANDS);
}

/**
 * 按「最近使用」重排命令。
 *
 * 只调整顺序，不改变匹配规则：搜索词非空时用户的意图是明确的，
 * 这时再用历史记录插队会让人觉得「我打的字不算数」。
 */
export function orderByRecent<T extends { id: string }>(commands: T[], recent: string[]): T[] {
  if (!recent.length) return commands;
  const rank = new Map(recent.map((id, index) => [id, index]));
  return [...commands].sort((a, b) => {
    const left = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}
