/**
 * 命令面板的纯逻辑：快捷键、摘要、模糊匹配与排序、键盘选择。
 *
 * 抽成纯函数有两个原因：
 * 1. 这些规则最容易在改界面时被悄悄改坏（比如「没匹配到就该提示」）；
 * 2. 不依赖 DOM 就能测，命令行里跑一遍就知道排序对不对。
 */

/** 一条命令。`keywords` 用于搜索，同时命中「别名」和「拼音首字母」。 */
export interface Command {
  /** 全局唯一标识。 */
  id: string;
  /** 展示文案。 */
  title: string;
  /** 归属分组，界面上按组排列。 */
  group: string;
  /** 额外搜索词：菜单的英文名、常见叫法。 */
  keywords: string[];
  /** 触发动作。面板只负责选中，不关心它做什么。 */
  run: () => void;
}

/** 一条命令在搜索结果中的位置。 */
export interface CommandMatch {
  command: Command;
  score: number;
}

/**
 * 匹配分档。数值只用来排序，具体大小没有语义。
 *
 * 精确 > 前缀 > 子串 > 关键字 > 摘要。低于 `SCORE_MIN` 视为不匹配。
 */
export const SCORE_EXACT = 100;
export const SCORE_PREFIX = 80;
export const SCORE_CONTAINS = 60;
export const SCORE_KEYWORD = 40;
export const SCORE_SUMMARY = 20;
/** 低于该分数视为不匹配，不进结果列表。 */
export const SCORE_MIN = 1;

/** 摘要展示的最大长度。列表里一行放得下，再多就只能靠搜索了。 */
const SUMMARY_LIMIT = 60;

/** 把摘要压成一行：换行和连续空白折叠成单个空格，超长截断。 */
export function summarize(text: string, limit: number = SUMMARY_LIMIT): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  // 用省略号而不是硬切：让「这里还有内容」这件事在界面上可见。
  return `${collapsed.slice(0, Math.max(limit - 1, 0))}…`;
}

/**
 * 单个命令对查询词的匹配分数，0 表示不匹配。
 *
 * 空查询返回 `SCORE_SUMMARY`，即「全部列出、保持原顺序」——命令面板打开时
 * 应该先给一份完整清单，而不是空白等用户输入。
 */
export function scoreCommand(command: Command, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return SCORE_SUMMARY;

  const title = command.title.toLowerCase();
  if (title === needle) return SCORE_EXACT;
  if (title.startsWith(needle)) return SCORE_PREFIX;
  if (title.includes(needle)) return SCORE_CONTAINS;
  // 关键字按同样规则降一档：用户先想的是菜单名，其次才是别名。
  if (command.keywords.some((word) => word.toLowerCase().includes(needle))) {
    return SCORE_KEYWORD;
  }
  return 0;
}

/**
 * 全量过滤 + 排序。
 *
 * 同分时保持原顺序（`sort` 在 V8 上是稳定排序），这样「概览」永远排在
 * 「概览详情」前面，不会因为打字而跳动。
 */
export function rankCommands(commands: Command[], query: string): CommandMatch[] {
  return commands
    .map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter((match) => match.score >= SCORE_MIN)
    .sort((a, b) => b.score - a.score);
}

/**
 * 上下键移动后的选中项。
 *
 * 越界回绕：在最后一项按 ↓ 回到第一项。面板是键盘驱动的，回绕比「顶住不动」
 * 少一次意外；`total` 为 0 时返回 -1，交给调用方渲染「无匹配」。
 */
export function moveSelection(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (((current + delta) % total) + total) % total;
}

/** 选中项落空（比如结果变少）时收敛到范围内。 */
export function clampSelection(current: number, total: number): number {
  if (total <= 0) return -1;
  return Math.min(Math.max(current, 0), total - 1);
}

/** 触发面板的按键组合。macOS 用 ⌘K，其余平台 Ctrl+K。 */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  isMac: boolean,
): boolean {
  if (event.key.toLowerCase() !== "k") return false;
  // 带 Alt / Shift 的组合留给别的功能，避免和输入法、终端习惯冲突。
  if (event.altKey || event.shiftKey) return false;
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * 触发设置弹窗的按键组合：⌘, / Ctrl+,。
 *
 * macOS 上是系统约定（几乎所有 App 都是这个键），Windows/Linux 上 Ctrl+, 也
 * 已经是主流习惯。两个平台的按键形式一致，差别只在修饰键 —— 与 `isPaletteShortcut`
 * 同一个写法。
 */
export function isSettingsShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  isMac: boolean,
): boolean {
  if (event.key !== ",") return false;
  if (event.altKey || event.shiftKey) return false;
  return isMac ? event.metaKey : event.ctrlKey;
}

/**
 * 是否是「正在输入文字」。面板靠全局 keydown 触发，但用户在输入框里打 k、
 * 或在中转站里按 Ctrl+K（浏览器习惯）时不该弹出来。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return element.isContentEditable;
}

/** 当前平台是否用 ⌘。服务端渲染（无 navigator）时按非 mac 处理。 */
export function isMacPlatform(): boolean {
  const source = typeof navigator === "undefined" ? "" : navigator.platform;
  return /mac|iphone|ipad/i.test(source);
}
