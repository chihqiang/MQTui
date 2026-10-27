/**
 * 虚拟窗口计算：纯函数 + 一个轻量 hook，便于单测也便于复用。
 */

import { useCallback, useState } from "react";

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

/** 维护滚动位置并返回当前可视区间。 */
export function useVirtualWindow(input: {
  itemCount: number;
  itemHeight: number;
  overscan?: number;
  defaultViewportHeight?: number;
}) {
  const { itemCount, itemHeight, overscan, defaultViewportHeight = 600 } = input;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(defaultViewportHeight);

  const onScroll = useCallback((nextScrollTop: number, nextViewportHeight: number) => {
    setScrollTop(nextScrollTop);
    // 视口高度只在变化时更新，避免无意义的 re-render。
    setViewportHeight((current) => (current === nextViewportHeight ? current : nextViewportHeight));
  }, []);

  return { ...computeRange({ itemCount, itemHeight, scrollTop, viewportHeight, overscan }), onScroll };
}
