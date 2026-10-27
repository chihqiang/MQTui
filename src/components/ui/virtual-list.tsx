import { useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";

import { clampScrollTop, isRestorable, restoreMoved, type ScrollMemory } from "@/lib/scroll-restore";
import { useVirtualWindow } from "@/lib/virtual-window";

/** 滚动停下多久之后把位置写进记忆表。 */
const SAVE_IDLE_MS = 150;

interface VirtualListProps<T> {
  items: T[];
  /** 单行高度（px），必须是固定值。 */
  itemHeight: number;
  overscan?: number;
  className?: string;
  /**
   * 数据源标识（topic / queue / 组名）。
   *
   * 虚拟列表最难处理的就是「滚动位置该不该重置」：换数据源必须回顶部，
   * 追加与过滤都不能。只看条数必错（追加变多，过滤变少），
   * 所以把「换没换数据源」这件事显式传进来。
   */
  resetKey?: string;
  /**
   * 位置记忆的键（通常是「页面 + 数据源」）。
   *
   * 传了它，虚拟列表在卸载时把滚动位置写进这张表，重新挂载时再读回来 ——
   * 「翻到底部看详情 → 返回」不该让人重新滚一遍。不传就是纯一次性列表。
   */
  scrollKey?: string;
  /** 记忆表由调用方持有，跨挂载存活。 */
  scrollMemory?: ScrollMemory;
  renderItem: (item: T, index: number) => ReactNode;
}

/**
 * 固定行高虚拟列表。
 *
 * Kafka / RabbitMQ 的消息列表动辄上万行，DOM 全量渲染会直接卡死，
 * 这里只渲染可视窗口 + 少量 overscan。
 *
 * 滚动手感的关键在于「滚动不等于重渲染」：内容层的位移由滚动处理器直接改
 * `transform`（合成层完成，不排队），`onScroll` 只在可见行真的换了时才
 * 让 React 参与计算。行组件请自带 `memo`，回调也别现写箭头函数，
 * 否则每次区间变化都会把没动过的行一起重渲染。
 */
export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 8,
  className,
  resetKey,
  scrollKey,
  scrollMemory,
  renderItem,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const prevKey = useRef(resetKey);
  const { start, end, offsetY, totalHeight, onScroll } = useVirtualWindow({
    itemCount: items.length,
    itemHeight,
    overscan,
  });

  /** 内容层的位移：滚动时直接改它，不经过 React。 */
  const contentRef = useRef<HTMLDivElement>(null);

  // 当前位置只写进 ref：滚动处理器每帧都在动它，走 state 就等于每帧重渲染。
  const positionRef = useRef(0);

  // 位置记忆：只在滚动结束时写一次。
  //
  // 原来想在滚动里逐帧写 Map，其实没必要 —— 记忆只在「离开这个列表」时才被读，
  // 滚动过程中写进去的值一次都不会用到，却要在每帧多一次 Map 写入。
  // 改成 150ms 静默后落一次，代价是丢「最后 150ms 内的滚动」，肉眼不可见。
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载前兜底：防抖计时器可能还在等，直接按当前位置落一次。
  useLayoutEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!scrollKey || !scrollMemory) return;
      const top = positionRef.current;
      if (isRestorable(top)) scrollMemory.set(scrollKey, top);
      else scrollMemory.delete(scrollKey);
    };
  }, [scrollKey, scrollMemory]);

  /**
   * 把容器滚到指定位置，同时把内容层的位移对齐。
   *
   * 两件事必须一起做：只改 `scrollTop` 的话，内容层的 `translateY` 还是滚动事件
   * 算出来的旧值，中间那一帧内容会错位再弹回来 —— 恢复位置时最容易看见的跳动。
   */
  const jumpTo = (top: number) => {
    const container = scrollRef.current;
    if (!container) return;
    if (restoreMoved(container.scrollTop, top)) container.scrollTop = top;
    positionRef.current = top;
    const quantized = top - (top % itemHeight);
    if (contentRef.current) contentRef.current.style.transform = `translateY(${quantized}px)`;
  };

  // 换数据源才回顶部。
  //
  // 这里刻意不用 items 引用判断：分页追加与过滤都会产生新数组，按引用重置等于
  // 「每翻一页被拽回顶部」。也不看条数：过滤把结果筛掉时条数一样会变少，
  // 那时用户的手还停在原地，不该被拽走。
  useLayoutEffect(() => {
    if (prevKey.current === resetKey) return;
    prevKey.current = resetKey;
    // 先归位再滚：滚动事件缺省由浏览器在这之后触发，两边对齐不会打架。
    jumpTo(0);
  }, [resetKey]);

  // 挂载时读回上一次的位置。
  //
  // 必须放进 `useLayoutEffect`（而不是 `useEffect`）：浏览器在绘制前就会应用
  // `scrollTop`，人看不到「先跳到顶部又被拽回来」那一下。
  // 依赖里带上总高度：位置记下来之后数据可能变少，夹取上限要跟着重算。
  useLayoutEffect(() => {
    if (!scrollKey || !scrollMemory) return;
    const desired = scrollMemory.get(scrollKey);
    if (desired === undefined) return;
    const container = scrollRef.current;
    if (!container) return;
    jumpTo(clampScrollTop(desired, totalHeight, container.clientHeight));
  }, [scrollKey, scrollMemory, totalHeight]);

  return (
    <div
      ref={scrollRef}
      className={className}
      onScroll={(event: UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        const top = element.scrollTop;
        positionRef.current = top;
        // 滚动期间先只挪 `translateY`，不重算区间。
        //
        // 这是「跟手」的来源：手指移动 → 内容跟着移动，全程发生在合成层，不排队等 React。
        // 区间计算（也就重渲染）交给 `useVirtualWindow` 里那层节流，只在可见区间真的换了
        // 一行以上时才发生；overscan 保证滚出可视区的行不会先露白。
        if (contentRef.current) {
          contentRef.current.style.transform = `translateY(${top - (top % itemHeight)}px)`;
        }
        onScroll(top, element.clientHeight);

        if (!scrollKey || !scrollMemory) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const resting = positionRef.current;
          if (isRestorable(resting)) scrollMemory.set(scrollKey, resting);
          else scrollMemory.delete(scrollKey);
        }, SAVE_IDLE_MS);
      }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div ref={contentRef} style={{ transform: `translateY(${offsetY}px)` }}>
          {items.slice(start, end).map((item, index) => renderItem(item, start + index))}
        </div>
      </div>
    </div>
  );
}
