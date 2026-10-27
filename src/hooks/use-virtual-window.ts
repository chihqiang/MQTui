/**
 * 虚拟窗口的 React 绑定。
 *
 * 计算在 `lib/virtual-window.ts` 里（纯函数，能被 `node --test` 直接跑）；
 * 这里只负责把滚动位置留在组件状态里。
 */

import { useCallback, useState } from "react";

import { computeRange, type VirtualRange } from "@/lib/virtual-window";

/**
 * 维护滚动位置并返回当前可视区间。
 *
 * 关键点：渲染调用只依赖「哪几行该画」和「内容层的位移」 —
 * 只要这几个数字没变，滚动就不该引发 React 更新。
 *
 * 实测一次滚轮连发（120Hz 触控板一秒能发一百多个事件）里，绝大多数事件
 * 落在同一行之内：区间没变、位移也可以直接由 DOM 承担。原来每来一个事件就
 * `setState`，于是「滚动」= 「每帧重渲染一屏元素」，列表越复杂越顿。
 */
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
    // 两个 `setState` 放在同一个 React 批次里，但值相同会被 React 直接跳过：
    // 滚动落在同一行之内时，这次调用等于免费的 —— 这是「滚一下不重渲染一屏」的关键。
    setScrollTop(nextScrollTop);
    setViewportHeight((current) => (current === nextViewportHeight ? current : nextViewportHeight));
  }, []);

  return {
    ...computeRange({ itemCount, itemHeight, scrollTop, viewportHeight, overscan }),
    onScroll,
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
