/**
 * 刷新时的界面行为。
 *
 * 抽成纯函数是因为这几条规则很容易在改页面时被顺手改坏，而且改了不会报错 ——
 * 只会让人觉得「这软件是不是有点旧」：
 *
 * 1. 刷新中，数字和徽标不该集体变灰。一次刷新 200ms，整页闪一下，
 *    人就分不清「数据变了」和「正在读」；
 * 2. 但也不能什么提示都不给 —— 否则点完「刷新」页面毫无反应，
 *    只能靠再点一次确认；
 * 3. 已经有数据时，刷新的失败不该把内容清空盖成一个大红叉。
 */

/** 刷新状态：只区分「首次加载」与「已有数据的基础上再读」。 */
export interface RefreshState {
  /** 首次加载：还没有任何数据。 */
  firstLoad: boolean;
  /** 后台正在读（首次加载之外）。 */
  refreshing: boolean;
  /** 有可显示的旧数据。 */
  hasData: boolean;
}

export function describeRefresh({
  firstLoad,
  refreshing,
  hasData,
}: RefreshState): {
  /** 内容区是否该整体换成骨架屏。 */
  showSkeleton: boolean;
  /** 是否该显示「刷新中」的细指示。 */
  showRefreshHint: boolean;
  /** 旧数据是否还该继续显示。 */
  keepStaleContent: boolean;
} {
  return {
    // 只有「一次数据都没有」时才铺骨架。刷新时铺骨架等于让用户读两遍同一块内容。
    showSkeleton: firstLoad && !hasData,
    // 首屏已经有骨架了，再叠一条「刷新中」是双重提示。
    showRefreshHint: refreshing && !firstLoad && hasData,
    keepStaleContent: hasData,
  };
}

/**
 * 细进度线该不该出现。
 *
 * 规则和 `showRefreshHint` 不同，多两条：
 *
 * 1. **留一个最短可见时间**。一次本地刷新常常 80ms 就回来了，进度线还没被看见
 *    就消失，等于没有 —— 但直接拖慢刷新来「演」一下更糟。
 * 2. **结束时不立刻抽走**，给它一个淡出窗口，避免在 60Hz 屏上闪成一道白光。
 *
 * 这是个纯函数：调得进、测得清，组件不自己算时间。
 */
export function progressBarVisible({
  active,
  endedAt,
  now,
  minVisibleMs = 240,
  fadeMs = 180,
}: {
  /** 当前是否正在刷新。 */
  active: boolean;
  /** 上一次刷新结束的时刻；`null` 表示从没刷新过。 */
  endedAt: number | null;
  now: number;
  minVisibleMs?: number;
  fadeMs?: number;
}): boolean {
  if (active) return true;
  if (endedAt === null) return false;
  return now - endedAt < Math.max(minVisibleMs, fadeMs);
}

/**
 * 刷新按钮的提示文案。
 *
 * 返回 `null` 表示不给提示：刚打开页面时按钮旁边不该有字，
 * 页面中间已经有骨架在说「正在读」了。
 */
export function refreshHintText(state: RefreshState, lastUpdated?: string): string | null {
  const { showRefreshHint } = describeRefresh(state);
  if (state.firstLoad) return null;
  if (showRefreshHint) return "刷新中…";
  return lastUpdated ? `数据更新于 ${lastUpdated}` : null;
}

/**
 * 相对时间：面板里说「3 分钟前」比一个绝对时间戳更好判断新鲜度。
 *
 * 超过一天就不再折算 —— 「27 小时前」不如「昨天 14:03」直观，
 * 但这里拿不到本地时区格式化的确定性结果，所以退化成「N 天前」。
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(now - timestamp, 0);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < 10_000) return "刚刚";
  if (diff < minute) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  return `${Math.floor(diff / day)} 天前`;
}

/**
 * 结果集比上一次短了没有。
 *
 * 分页续读天然带来新数组引用，靠引用比对判断「要不要回顶部」必然误伤；
 * 但条数变少又有两种情况，处置完全不同：
 *
 * - 换了数据源（切 topic、换队列）→ 必须回顶部，否则还停在上一份数据的滚动位置；
 * - 只是过滤把结果筛掉了 → 不能回顶部，用户手还停在原地扫，
 *   位置被拽走就得重新找。
 *
 * 所以判断「要不要重置滚动」的输入不只是条数，还有数据源有没有变。
 */
export function scrollResetNeeded({
  sourceChanged,
}: {
  sourceChanged: boolean;
  /** 上一轮与下一轮的条数。当前不参与判断，留着是给调用方一个显式的落点。 */
  previousCount: number;
  nextCount: number;
}): boolean {
  // 只有换数据源才回到顶部。
  //
  // 追加（条数变多）时保留位置是分页能用的前提；过滤把结果筛掉（条数变少）时
  // 也不能回顶部 —— 用户的手还停在原地扫，位置被拽走就得重新找。
  // 之前按「条数变少」判定，结果「筛到 0 条」会把列表拽回顶部。
  return sourceChanged;
}

/**
 * 过滤无命中时，还要不要把继续加载的入口留着。
 *
 * 这是个很容易做反的地方：筛掉全部结果后顺手把「加载更多」也藏起来，
 * 看起来干净，实际把用户困在「当前这一屏什么都没有」里 —— 旧消息再也翻不到。
 */
export function keepLoadMoreVisible({
  hasMore,
  visibleCount,
}: {
  hasMore: boolean;
  visibleCount: number;
}): boolean {
  return hasMore && visibleCount === 0;
}
