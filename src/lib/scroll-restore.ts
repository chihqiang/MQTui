/**
 * 虚拟列表的滚动位置记忆。
 *
 * 面板的典型动作是「在消息列表里翻到第 800 条 → 点开一条看详情 → 返回」。
 * 返回时列表重新挂载，滚动位置归零，人得重新滚回刚才那一屏 —— 这条路径
 * 每看一条详情就要付一次，比任何动效都更消耗耐心。
 *
 * 这里只做纯计算：记什么键、什么时候该恢复、恢复的目标夹在哪个区间。
 * 真正的读写挂在调用方（`VirtualList`），便于单测。
 */

/** 记忆表：键 → 滚动位置（px）。 */
export type ScrollMemory = Map<string, number>;

/**
 * 位置是否还值得记。
 *
 * 顶部（`< 1px`）不记：用户本来就没往下翻，记一个 0 只会让下次恢复时白跑一遍；
 * 负数与 `NaN` 直接当作无效 —— 容器还没布局完时 `scrollTop` 可能读出脏值。
 */
export function isRestorable(scrollTop: number): boolean {
  return Number.isFinite(scrollTop) && scrollTop >= 1;
}

/**
 * 恢复时的目标位置。
 *
 * 数据变少（过滤、换页、消息被消费掉）时原来的位置可能已经超出内容高度，
 * 直接赋一个越界值会被浏览器夹到最大值，滚动条和渲染区间就此错开一层。
 * 这里主动夹到最后一行，让两边用的是同一个数。
 */
export function clampScrollTop(desired: number, totalHeight: number, viewportHeight: number): number {
  if (!Number.isFinite(desired) || desired <= 0) return 0;
  const max = Math.max(totalHeight - viewportHeight, 0);
  return Math.min(desired, max);
}

/**
 * 同一份数据里，位置被「调整」过没有。
 *
 * 只有真的需要动才写 `scrollTop`：无谓的赋值会触发一次滚动事件，
 * 而滚动事件又会走一遍区间计算。返回 false 时调用方什么都不用做。
 */
export function restoreMoved(previous: number, next: number): boolean {
  return Math.abs(previous - next) >= 1;
}
