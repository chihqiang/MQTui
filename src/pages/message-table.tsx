import { useEffect, useMemo, useRef, useState } from "react";

import { Button, ErrorState, Input, VirtualList } from "@/components/ui";
import { useMessages } from "@/hooks/use-messages";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import {
  EMPTY_FILTER,
  filterMessages,
  isFilterActive,
  type MessageFilter,
} from "@/lib/message-filter";
import type { MessageSummary } from "@/types";

interface Props {
  connectionId: string;
  target: string;
  /** 选中一行。回传整条摘要，RabbitMQ 的 payload 就在里面，详情无需再请求。 */
  onSelect: (message: MessageSummary) => void;
}

/** 行高固定，配合虚拟列表使用。 */
const ROW_HEIGHT = 40;

/**
 * 消息列表：虚拟滚动 + 分页加载。
 *
 * 「加载最新」丢弃游标重新读最新一页，「加载更多」顺着游标往前读更旧的消息，
 * 两条路径都由后端返回的 cursor 驱动。滚动到底部时自动续读。
 *
 * 过滤只作用于「已加载」的消息：翻页仍在继续，命中集随之变长，
 * 因此不会出现「过滤后加载更多按钮消失、旧消息再也翻不到」的情况。
 */
export function MessageTable({ connectionId, target, onSelect }: Props) {
  const {
    data,
    isLoading,
    error,
    refetch,
    // 「加载最新」要回到第一页，不能只 refetch：``useInfiniteQuery`` 的 refetch
    // 会把所有已翻的页一起重拉，翻得越深撤得越狠。
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useMessages({ connectionId, target });

  // 分页结果按页顺序摊平，第一页是最新的，越往后越旧。
  const loaded = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  // 过滤只在已加载的消息里做，不发请求：继续往下翻仍会追加，过滤结果随之变长。
  const [filter, setFilter] = useState<MessageFilter>(EMPTY_FILTER);
  const items = useMemo(() => filterMessages(loaded, filter), [loaded, filter]);

  // 换数据源时清空过滤条件，免得带着上一个 topic 的关键字看空列表。
  useEffect(() => {
    setFilter(EMPTY_FILTER);
  }, [connectionId, target]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || isFetchingNextPage) return;

    // 底部 200px 提前预读，滚动体验更连续。
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  if (isLoading) {
    return <p className="p-4 text-sm text-slate-400">读取消息中…</p>;
  }
  if (error) {
    return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  }
  if (!loaded.length) {
    return <p className="p-4 text-sm text-slate-400">该 {target} 暂无消息</p>;
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-800">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
        <span>
          {target} · 已加载 {formatNumber(loaded.length)} 条
          {isFilterActive(filter) ? ` · 命中 ${formatNumber(items.length)} 条` : ""}
        </span>
        <span className="flex items-center gap-3">
          <button
            type="button"
            disabled={isRefetching}
            onClick={() => void refetch()}
            className="text-sky-300 hover:text-sky-200 disabled:text-slate-600"
          >
            {isRefetching ? "读取中…" : "加载最新"}
          </button>
          {hasNextPage ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "加载中…" : "加载更多"}
            </Button>
          ) : (
            <span className="text-slate-600">已到日志头部</span>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <Input
          value={filter.key}
          onChange={(event) => {
            const key = event.currentTarget.value;
            setFilter((prev) => ({ ...prev, key }));
          }}
          placeholder="按 key 过滤"
          className="h-8 w-40 text-xs"
        />
        <Input
          value={filter.content}
          onChange={(event) => {
            const content = event.currentTarget.value;
            setFilter((prev) => ({ ...prev, content }));
          }}
          placeholder="按内容过滤（不区分大小写）"
          className="h-8 flex-1 text-xs"
        />
        {isFilterActive(filter) ? (
          <Button size="sm" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
            清除
          </Button>
        ) : null}
      </div>

      {items.length ? (
        <VirtualList
          items={items}
        itemHeight={ROW_HEIGHT}
        className="min-h-0 flex-1 overflow-auto"
          renderItem={(message) => (
            <MessageRow key={message.id} message={message} onClick={() => onSelect(message)} />
          )}
        />
      ) : (
        <p className="p-4 text-sm text-slate-400">
          已加载的 {formatNumber(loaded.length)} 条消息里没有匹配项，继续往下翻会重新过滤
        </p>
      )}

      {hasNextPage ? <div ref={sentinelRef} className="h-px shrink-0" /> : null}
    </div>
  );
}

function MessageRow({ message, onClick }: { message: MessageSummary; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ height: ROW_HEIGHT }}
      className="flex w-full items-center gap-3 border-b border-slate-800/60 px-3 text-left text-xs hover:bg-slate-800/50"
    >
      <span className="w-40 shrink-0 truncate text-slate-500">
        {formatTimestamp(message.timestamp)}
      </span>
      <span className="w-16 shrink-0 text-slate-500">
        {message.partition !== undefined ? `P${message.partition}` : "-"}
      </span>
      <span className="w-20 shrink-0 text-slate-500">{formatNumber(message.offset)}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-slate-200">{message.preview}</span>
      <span className="w-16 shrink-0 text-right text-slate-500">{formatBytes(message.size)}</span>
    </button>
  );
}
