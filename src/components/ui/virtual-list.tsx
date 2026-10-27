import { useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";

import { useVirtualWindow } from "@/lib/virtual-window";

interface VirtualListProps<T> {
  items: T[];
  /** 单行高度（px），必须是固定值。 */
  itemHeight: number;
  overscan?: number;
  className?: string;
  renderItem: (item: T, index: number) => ReactNode;
}

/**
 * 固定行高虚拟列表。
 *
 * Kafka / RabbitMQ 的消息列表动辄上万行，DOM 全量渲染会直接卡死，
 * 这里只渲染可视窗口 + 少量 overscan。
 */
export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 8,
  className,
  renderItem,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { start, end, offsetY, totalHeight, onScroll } = useVirtualWindow({
    itemCount: items.length,
    itemHeight,
    overscan,
  });

  // 数据源「换了」才回到顶部。
  //
  // 这里刻意用 items.length 判断而不是 items 引用：分页追加时数组也是新引用，
  // 若按引用重置，用户每翻一页都会被拽回顶部，滚动位置等于白滚。
  // 换数据源（切 topic / 「加载最新」丢弃已翻的页）时条数一定变小，此时才回到顶部。
  const prevCount = useRef(items.length);
  useLayoutEffect(() => {
    if (items.length < prevCount.current) {
      scrollRef.current?.scrollTo({ top: 0 });
    }
    prevCount.current = items.length;
  }, [items.length]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    onScroll(event.currentTarget.scrollTop, event.currentTarget.clientHeight);
  };

  return (
    <div ref={scrollRef} className={className} onScroll={handleScroll}>
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {items.slice(start, end).map((item, index) => renderItem(item, start + index))}
        </div>
      </div>
    </div>
  );
}
