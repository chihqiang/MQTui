/**
 * 虚拟窗口计算：纯函数，便于单测也便于复用。
 *
 * 这里**不**放 hook：vitest 直接跑 `.mts`，模块一旦 import `react`
 * 就解析不到包（lib 是给纯逻辑用的）。React 那一层见 `hooks/use-virtual-window.ts`。
 */

export interface ComputeRangeInput {
  itemCount: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}

export interface VirtualRange {
  start: number;
  end: number;
  offsetY: number;
  totalHeight: number;
}

/** 计算需要渲染的区间。 */
export function computeRange({
  itemCount,
  itemHeight,
  scrollTop,
  viewportHeight,
  overscan = 8,
}: ComputeRangeInput): VirtualRange {
  if (itemCount <= 0 || itemHeight <= 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight: 0 };
  }

  const visibleCount = Math.ceil(viewportHeight / itemHeight);
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const end = Math.min(itemCount, start + visibleCount + overscan * 2);

  return {
    start,
    end,
    offsetY: start * itemHeight,
    totalHeight: itemCount * itemHeight,
  };
}

/**
 * 同一次滚动里，可见区间是否需要重算。
 *
 * 判据只有「行区间」和「总高度」：`offsetY` 不参与 —— 内容层的位移由滚动处理器
 * 直接改 `transform`，如果把它也算进判据，就等于又回到「每个滚动事件都重渲染」。
 */
export function windowChanged(previous: VirtualRange, next: VirtualRange): boolean {
  return (
    previous.start !== next.start ||
    previous.end !== next.end ||
    previous.totalHeight !== next.totalHeight
  );
}

/**
 * 该不该因为这次滚动而重渲染。
 *
 * 判据是「可见区间有没有变」：行数不变时，同一屏内容 + 改动 `translateY` 就够，
 * 不需要 React 参与。抽成纯函数是因为这条规则一旦写反（比如按像素差判断），
 * 就会退化成「每个滚动事件都重渲染」，而界面上看不出来，只觉得卡。
 */
export function shouldRecomputeWindow(
  previous: VirtualRange,
  next: VirtualRange,
): boolean {
  return windowChanged(previous, next);
}
