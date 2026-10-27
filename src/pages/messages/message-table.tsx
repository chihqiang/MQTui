import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  Button,
  ErrorState,
  ListFooter,
  RefreshBar,
  SearchInput,
  Skeleton,
  StaleNotice,
  VirtualList,
} from "@/components/ui";
import { useFreshness } from "@/hooks/use-freshness";
import { useMessages } from "@/hooks/use-messages";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import { DENSITY, densityRowHeight } from "@/lib/list-view";
import { keepLoadMoreVisible } from "@/lib/refresh";
import type { ScrollMemory } from "@/lib/scroll-restore";
import { IconDeadLetter, IconRedeliver, IconResend } from "@/lib/icons";
import {
  EMPTY_FILTER,
  filterMessages,
  isFilterActive,
  type MessageFilter,
} from "@/lib/message-filter";
import type { DisposalAction, MessageSummary } from "@/types";

import { MessageBatchDisposalDialog } from "@/pages/messages/message-batch-disposal";
import { MessageDisposalDialog } from "@/pages/messages/message-disposal";
import { MessageResendDialog } from "@/pages/messages/message-resend";

interface Props {
  connectionId: string;
  target: string;
  /** 选中一行。回传整条摘要，RabbitMQ 的 payload 就在里面，详情无需再请求。 */
  onSelect: (message: MessageSummary) => void;
  /** 是否显示 RabbitMQ 的消息处置入口（重投 / 移入死信）。 */
  canDispose?: boolean;
  /** 是否显示 Kafka 的重发入口。 */
  canResend?: boolean;
}

/**
 * 行高跟随全站密度档。
 *
 * 原来写死 34：切到「宽松」档时行内边距变大、行高没变，行被挤扁；
 * 更糟的是虚拟列表按 34 算偏移，行越高偏得越多 —— 越往下滚，
 * 「滚一格走三行」越明显。行高与行内边距现在同出一源（`lib/list-view`）。
 */

/** 首屏骨架：行高与真实行一致，数据到位时列不会跳。 */
function MessageListSkeleton({ target }: { target: string }) {
  return (
    <div
      className="flex h-full flex-col rounded-lg border border-slate-200"
      role="status"
      aria-label="读取消息中"
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 text-(length:--text-app-body) text-slate-500">
        {target} · 读取消息中…
      </div>
      <div className="flex flex-col gap-1 p-2">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton
            key={index}
            className="h-6"
            // 错开的宽度像真数据，不像一排整齐的灰条。
            style={{ width: `${94 - (index % 5) * 9}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 消息列表：虚拟滚动 + 分页加载。
 *
 * 「加载最新」丢弃游标重新读最新一页，「加载更多」顺着游标往前读更旧的消息，
 * 两条路径都由后端返回的 cursor 驱动。滚动到底部时自动续读。
 *
 * 过滤只作用于「已加载」的消息：翻页仍在继续，命中集随之变长，
 * 因此不会出现「过滤后加载更多按钮消失、旧消息再也翻不到」的情况。
 *
 * 键盘操作：↑↓ 移动、Enter 看详情、Space 勾选。消息列表是排查时的高频区，
 * 一行一行用鼠标点太慢，尤其要把相邻几条一起处置的时候。
 */
export function MessageTable({
  connectionId,
  target,
  onSelect,
  canDispose,
  canResend,
}: Props) {
  const {
    data,
    isLoading,
    isFetching,
    error,
    dataUpdatedAt,
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

  // 处置弹窗：记录「哪条消息 + 哪个动作」，关掉即清空。
  const [disposal, setDisposal] = useState<{
    message: MessageSummary;
    action: "redeliver" | "deadLetter";
  } | null>(null);
  // 重发弹窗：Kafka 独有，记录要重发哪一条。
  const [resend, setResend] = useState<MessageSummary | null>(null);

  // 多选：批量处置用。只对 RabbitMQ 开放——它的处置是「一条一条从队列里取出来」，
  // 批量能省掉几十次重复的开关通道。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<DisposalAction | null>(null);
  const selectable = Boolean(canDispose);

  // 换数据源时清空选中集：上一个 topic 的投递标签在新队列里毫无意义。
  useEffect(() => {
    setSelected(new Set());
  }, [connectionId, target]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 选中的消息按列表顺序取，保证回报顺序和用户看到的顺序一致。
  const selectedMessages = useMemo(
    () => items.filter((message) => selected.has(message.id)),
    [items, selected],
  );

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

  // 键盘游标：只记「第几行」，滚动跟随交给容器自己。
  const [cursor, setCursor] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // 位置记忆：点开一条消息看详情、再返回时回到刚才那一屏。
  //
  // 记忆表挂在组件实例上（`useRef`），而消息页本身不随详情弹窗卸载 ——
  // 弹窗是就地渲染的，所以这里真正受益的是「切到别的菜单再切回来」。
  // 换 topic / queue 时键里带了数据源，天然不会串位置。
  const scrollMemoryRef = useRef<ScrollMemory>(new Map());

  // 过滤条件变了，游标可能指向另一条消息，直接复位比猜一个位置稳妥。
  useEffect(() => {
    setCursor(-1);
  }, [filter.key, filter.content]);

  // 行高只有一个来源：`VirtualList` 的偏移量、键盘滚动、行高必须是同一个数。
  const rowHeight = densityRowHeight(DENSITY);

  // 行回调统一收到这里，不写在 `renderItem` 的内联箭头里：
  // 内联箭头每行都是新引用，`MessageRow` 的 memo 就白加了。
  const openRow = useCallback(
    (message: MessageSummary, index: number) => {
      setCursor(index);
      onSelect(message);
    },
    [onSelect],
  );

  const disposeRow = useCallback(
    (message: MessageSummary, action: DisposalAction) => setDisposal({ message, action }),
    [],
  );

  const renderRow = useCallback(
    (message: MessageSummary, index: number) => (
      <MessageRow
        key={message.id}
        message={message}
        index={index}
        rowHeight={rowHeight}
        active={index === cursor}
        checked={selected.has(message.id)}
        onToggle={selectable ? toggle : undefined}
        onOpen={openRow}
        onDispose={canDispose ? disposeRow : undefined}
        onResend={canResend ? setResend : undefined}
      />
    ),
    [
      canDispose,
      canResend,
      cursor,
      disposeRow,
      openRow,
      rowHeight,
      selectable,
      selected,
      toggle,
    ],
  );

  const moveCursor = (delta: number) => {
    if (!items.length) return;
    const next = cursor < 0 ? (delta > 0 ? 0 : items.length - 1) : cursor + delta;
    const clamped = Math.min(Math.max(next, 0), items.length - 1);
    setCursor(clamped);
    // 让选中行始终留在视口里。虚拟列表的 DOM 会随滚动增删，用滚动容器算更稳。
    const container = listRef.current;
    if (!container) return;
    const top = clamped * rowHeight;
    const bottom = top + rowHeight;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveCursor(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    const current = items[cursor];
    if (!current) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onSelect(current);
    }
    if (event.key === " " && selectable) {
      event.preventDefault();
      toggle(current.id);
    }
  };

  // 首屏没有数据才铺骨架；之后任何一次重新读取都不该把列表换成灰条 ——
  // 「加载最新」时整块闪一下，位置和当前读到的内容全丢了。
  if (isLoading && !loaded.length) {
    return (
      <MessageListSkeleton target={target} />
    );
  }

  // 一条都没读到、又确实失败了，才让错误页占据内容区。
  if (error && !loaded.length) {
    return (
      <ErrorState
        message={failureText("读取消息", errorMessage(error), target)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!loaded.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        {error ? (
          <StaleNotice
            message={failureText("读取消息", errorMessage(error), target)}
            onRetry={() => void refetch()}
          />
        ) : null}
        <p className="text-(length:--text-app-title) text-slate-500">该 {target} 暂无消息</p>
        <p className="text-(length:--text-app-body) text-slate-500">生产者还没写入，或者消息已被消费且未被保留</p>
        <Button size="xs" variant="secondary" onClick={() => void refetch()} title="丢掉游标重新读最新一页">
          重新读取
        </Button>
      </div>
    );
  }

  // 新鲜度需要「过一会儿就变」，靠一个 5 秒的节拍重渲染。比给每一行挂定时器便宜得多。
  const freshness = useFreshness(dataUpdatedAt, isFetching);

  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-200">
      {/* 刷新时的唯一提示：一条沿线滚动的细线。不占高度，也不把列表换成灰条。 */}
      <RefreshBar active={isRefetching} />

      {error && loaded.length ? (
        <div className="border-b border-slate-200 px-2 py-1.5">
          <StaleNotice
            message={failureText("刷新消息", errorMessage(error), target)}
            onRetry={() => void refetch()}
          >
            下面是上一次读到的结果
          </StaleNotice>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-1.5 text-(length:--text-app-body) text-slate-500">
        <span className="min-w-0 truncate">
          {target} · 已加载 <span className="tabular">{formatNumber(loaded.length)}</span> 条
          {isFilterActive(filter) ? (
            <span className="text-info">
              {" "}
              · 命中 <span className="tabular">{formatNumber(items.length)}</span> 条
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {hasNextPage ? (
            <Button
              size="xs"
              variant="secondary"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              加载更多
            </Button>
          ) : (
            <span className="text-meta">已到日志头部</span>
          )}
          {/* 读消息是高频动作，「这屏数据是哪一刻的」比一个刷新按钮更有用。 */}
          <span className="tabular text-(length:--text-app-meta) text-meta">{freshness}</span>
          <Button
            size="xs"
            variant="ghost"
            loading={isRefetching}
            onClick={() => void refetch()}
            title="丢掉游标，重新读最新一页"
          >
            加载最新
          </Button>
        </span>
      </div>

      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5">
        {/*
          两个过滤框原来左边没放大镜、右边却有一个 ✕ —— 点进去的第一眼
          分不清哪个是「搜 key」哪个是「搜内容」。补上放大镜之后盒子宽度
          必须留在外面：`SearchInput` 现在是胶囊容器，`flex-1` 给内层 input
          是不起作用的。
        */}
        <SearchInput
          value={filter.key}
          onValueChange={(key) => setFilter((prev) => ({ ...prev, key }))}
          placeholder="按 key 过滤"
          aria-label="按 key 过滤"
          icon
          className="w-40 shrink-0"
        />
        <SearchInput
          value={filter.content}
          onValueChange={(content) => setFilter((prev) => ({ ...prev, content }))}
          placeholder="按内容过滤（不区分大小写）"
          aria-label="按内容过滤"
          icon
          className="min-w-0 flex-1"
        />
        {isFilterActive(filter) ? (
          <Button size="xs" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
            清除
          </Button>
        ) : null}
        {selectable && selected.size ? (
          <span className="flex shrink-0 items-center gap-1 border-l border-slate-200 pl-2">
            <span className="text-(length:--text-app-meta) text-slate-600">
              已选 <span className="tabular">{formatNumber(selected.size)}</span>
            </span>
            <Button size="xs" variant="secondary" onClick={() => setBatch("redeliver")}>
              重投
            </Button>
            <Button
              size="xs"
              variant="secondary"
              icon={<IconDeadLetter size={12} />}
              onClick={() => setBatch("deadLetter")}
            >
              死信
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
              取消
            </Button>
          </span>
        ) : null}
      </div>

      {items.length ? (
        // tabIndex 让整块可聚焦：点一下列表再按 ↑↓ 就能走，不必先点中某一行。
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          role="grid"
          aria-label="消息列表"
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <VirtualList
            items={items}
            itemHeight={rowHeight}
            // 只有换 topic / queue 才回顶部；过滤把结果筛掉时手不该被拽走。
            resetKey={`${connectionId}|${target}`}
            scrollKey={`messages|${connectionId}|${target}`}
            scrollMemory={scrollMemoryRef.current}
            renderItem={renderRow}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-(length:--text-app-title) text-slate-500">
          <p>已加载的 {formatNumber(loaded.length)} 条消息里没有匹配项</p>
          <p className="text-(length:--text-app-body) text-slate-500">
            {keepLoadMoreVisible({ hasMore: Boolean(hasNextPage), visibleCount: 0 })
              ? "继续往下翻会重新过滤，或清掉过滤条件"
              : "日志已经读完，清掉过滤条件看看全部消息"}
          </p>
          <div className="flex items-center gap-2">
            {/* 过滤把结果筛空时，「加载更多」必须留着 —— 否则旧消息再也翻不到。 */}
            {keepLoadMoreVisible({ hasMore: Boolean(hasNextPage), visibleCount: 0 }) ? (
              <Button
                size="xs"
                variant="secondary"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                继续加载更早的消息
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
              清除过滤
            </Button>
          </div>
        </div>
      )}

      {/* 续读指示：滚到这儿就该开始拉下一页，拉起时给条转圈，别让底部空着。 */}
      <ListFooter hasMore={Boolean(hasNextPage)} loading={isFetchingNextPage} />

      {hasNextPage ? <div ref={sentinelRef} className="h-px shrink-0" /> : null}

      {disposal ? (
        <MessageDisposalDialog
          connectionId={connectionId}
          message={disposal.message}
          action={disposal.action}
          onClose={() => setDisposal(null)}
        />
      ) : null}

      {batch && selectedMessages.length ? (
        <MessageBatchDisposalDialog
          connectionId={connectionId}
          messages={selectedMessages}
          action={batch}
          onClose={() => setBatch(null)}
          onDisposed={(ids) =>
            setSelected((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.delete(id);
              return next;
            })
          }
        />
      ) : null}

      {resend ? (
        <MessageResendDialog
          connectionId={connectionId}
          message={resend}
          onClose={() => setResend(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 一行消息。
 *
 * `memo` 不是装饰：虚拟列表每次重算区间都会重跑 `renderItem`，而
 * `renderItem` 里带着 `() => { ... }` 这样的内联箭头函数 —— 引用每次都是新的，
 * 不 `memo` 的话滚动时会连「没动过的那几十行」一起重渲染。行内还有按钮组、
 * 格式化过的四五个字段，代价不小。这里比较的是消息对象本身（列表数据是稳定引用）。
 */
const MessageRow = memo(function MessageRow({
  message,
  index,
  rowHeight,
  active,
  checked,
  onToggle,
  onOpen,
  onDispose,
  onResend,
}: {
  message: MessageSummary;
  /** 行在列表里的序号，回调把它交回去，避免每行各自包一层箭头函数。 */
  index: number;
  /** 行高（px），由调用方的密度档决定。 */
  rowHeight: number;
  /** 键盘游标所在行。 */
  active: boolean;
  checked: boolean;
  /** 不传表示这一行不可多选。 */
  onToggle?: (id: string) => void;
  onOpen: (message: MessageSummary, index: number) => void;
  onDispose?: (message: MessageSummary, action: DisposalAction) => void;
  onResend?: (message: MessageSummary) => void;
}) {
  return (
    <div
      style={{ height: rowHeight }}
      className={
        active
          ? "group flex w-full items-center gap-3 border-b border-slate-200 bg-selection px-3 text-(length:--text-app-body)"
          : "group flex w-full items-center gap-3 border-b border-slate-200 px-3 text-(length:--text-app-body) transition-colors hover:bg-slate-100"
      }
    >
      {/* 勾选框点选即加入批量，不进详情；整行点击仍然是「看这条」。 */}
      {onToggle ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(message.id)}
          aria-label={`选择消息 ${message.id}`}
          className="size-3.5 shrink-0 accent-indigo-600"
        />
      ) : null}
      {/* 整行点击进详情用按钮包住文字区，操作按钮留在外面，避免嵌套 button。 */}
      <button
        type="button"
        onClick={() => onOpen(message, index)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="tabular w-36 shrink-0 truncate text-meta">
          {formatTimestamp(message.timestamp)}
        </span>
        <span className="tabular w-12 shrink-0 text-meta">
          {message.partition !== undefined ? `P${message.partition}` : "-"}
        </span>
        <span className="tabular w-20 shrink-0 text-meta">{formatNumber(message.offset)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-slate-800">
          {message.preview || <span className="text-meta">(空消息)</span>}
        </span>
        <span className="tabular w-14 shrink-0 text-right text-meta">
          {formatBytes(message.size)}
        </span>
      </button>

      {onDispose || onResend ? (
        // 常驻但压低对比度（opacity-40），悬停或键盘游标落在这一行时升到满。
        //
        // 原来是 `opacity-0 group-hover:opacity-100`：鼠标从行尾划过时整条
        // 操作区会一闪一闪，而且不可发现 —— 用户可能永远不知道这里能处置消息。
        // 低对比度常驻比「悬停才出现」多解释了一件事：这一行是有动作的。
        <span
          className={
            active
              ? "flex shrink-0 items-center gap-1"
              : "flex shrink-0 items-center gap-1 opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          }
        >
          {onResend ? (
            <RowAction
              label="重发"
              icon={<IconResend size={11} />}
              onClick={() => onResend(message)}
            />
          ) : null}
          {onDispose ? (
            <>
              <RowAction
                label="重投"
                icon={<IconRedeliver size={11} />}
                onClick={() => onDispose(message, "redeliver")}
              />
              <RowAction
                label="死信"
                icon={<IconDeadLetter size={11} />}
                onClick={() => onDispose(message, "deadLetter")}
              />
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});

/** 行内小动作。悬停才出现，避免满屏按钮抢走内容。 */
function RowAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-slate-300 px-1.5 py-0.5 text-(length:--text-app-meta) text-slate-600 transition-colors hover:border-accent hover:text-info"
    >
      {icon}
      {label}
    </button>
  );
}
