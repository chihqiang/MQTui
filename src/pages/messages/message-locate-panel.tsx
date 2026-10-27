import { useState } from "react";

import { Button, Input, VirtualList } from "@/components/ui";
import {
  LOCATE_LIMIT,
  appendPage,
  bucketHits,
  describeScanProgress,
  useMessageLocate,
  type LocatePage,
} from "@/hooks/use-message-locate";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import {
  buildLocateRequest,
  completeContentRange,
  EMPTY_LOCATE_FORM,
  isLocateFormEmpty,
  locateFormIssue,
  parseLocalDateTime,
  shiftContentRange,
  type ContentStep,
  type LocateForm,
} from "@/lib/message-locate";
import type { MessageLocate, MessageSummary } from "@/types";

interface Props {
  connectionId: string;
  target: string;
  onSelect: (message: MessageSummary) => void;
}

/** 行高固定，与消息列表保持一致。 */
const ROW_HEIGHT = 40;

/**
 * Kafka 消息定位：按 key 或时间区间在日志里找消息。
 *
 * 这不是索引查询，是一次有上限的顺序扫描。所以界面必须把三件事说清楚：
 * 扫描范围（在哪读）、代价（扫了多少条）、是否被截断（可能还有）。
 * 少说任何一件，用户都会误以为「没找到 = 不存在」。
 *
 * 「继续扫描」不是重跑一次同样的条件（那会把已看过的部分重读一遍），
 * 而是把后端给的游标原样回传，从每个分区上次停下的位置接着读。
 */
export function MessageLocatePanel({ connectionId, target, onSelect }: Props) {
  const [form, setForm] = useState<LocateForm>(EMPTY_LOCATE_FORM);
  // 只有点过「定位」才真正提交条件：边输入边扫会把集群当成自己的打字机。
  const [submitted, setSubmitted] = useState<LocateForm>(EMPTY_LOCATE_FORM);
  const [page, setPage] = useState<LocatePage | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const locate = useMessageLocate();
  // 实际下发的区间。内容搜索会在发请求前补齐区间，这里记下补齐后的结果，
  // 让「往前挪一小时」这类操作有确定的目标，而不是基于用户看到的半个区间去猜。
  const [applied, setApplied] = useState<LocateForm>(EMPTY_LOCATE_FORM);

  const issue = locateFormIssue(form);
  const update = (patch: Partial<LocateForm>) => setForm((prev) => ({ ...prev, ...patch }));
  const submittedEmpty = isLocateFormEmpty(submitted);
  const contentMode = form.content.trim() !== "";
  // 实际区间：优先展示补齐后的结果，让「自动补窗口」这件事可见。
  const appliedRange =
    applied.after && applied.before
      ? `${applied.after.replace("T", " ")} ~ ${applied.before.replace("T", " ")}`
      : null;
  // 分段条只认「实际下发的区间」：用户改了表单但没点定位时，分段不该跟着动。
  const appliedRangeMs: [number, number] | undefined = (() => {
    const after = parseLocalDateTime(applied.after);
    const before = parseLocalDateTime(applied.before);
    return after !== undefined && before !== undefined && before > after
      ? [after, before]
      : undefined;
  })();

  const requestFor = (cursor?: string): MessageLocate | null => {
    const request = buildLocateRequest(connectionId, target, submitted, LOCATE_LIMIT);
    return request ? { ...request, cursor } : null;
  };

  const start = (override?: LocateForm) => {
    const source = override ?? submitted;
    const request = buildLocateRequest(connectionId, target, source, LOCATE_LIMIT);
    if (!request) return;
    const effective = completeContentRange(source);
    setNotice(null);
    setPage(undefined);
    setApplied(effective);
    if (override) setForm(effective);
    locate.mutate(request, { onSuccess: (result) => setPage(appendPage(undefined, result)) });
  };

  /** 把当前区间整体挪一步并立刻重扫：挪完区间，旧结果就不再对应新条件了。 */
  const shift = (step: ContentStep) => {
    const base = applied.after || applied.before ? applied : submitted;
    const next = shiftContentRange(base, step);
    if (next.after === applied.after && next.before === applied.before) return;
    setForm(next);
    setSubmitted(next);
    start(next);
  };

  const resume = () => {
    const request = requestFor(page?.cursor);
    if (!request) return;
    const scannedBefore = page?.totalScanned ?? 0;
    setNotice(null);
    locate.mutate(request, {
      onSuccess: (result) => {
        const next = appendPage(page, result);
        setPage(next);
        // 续扫没带来任何新命中时要说出来：否则按了「继续」页面毫无变化，
        // 用户无法判断是没读到、还是按钮坏了。
        if (result.items.length === 0) {
          setNotice(`续扫了 ${formatNumber(next.totalScanned - scannedBefore)} 条，没有新的命中`);
        }
      },
    });
  };

  const canResume = Boolean(page?.cursor) && !locate.isPending;

  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-200">
      <form
        className="flex flex-wrap items-end gap-2 border-b border-slate-200 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (issue) return;
          setSubmitted(form);
          start(form);
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-(length:--text-app-meta) text-slate-500">key（精确匹配）</span>
          <Input
            value={form.key}
            onChange={(event) => update({ key: event.currentTarget.value })}
            placeholder="如 order-1001"
            className="h-8 w-44 text-(length:--text-app-body)"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-(length:--text-app-meta) text-slate-500">内容片段（须配时间区间）</span>
          <Input
            value={form.content}
            onChange={(event) => update({ content: event.currentTarget.value })}
            placeholder="如 timeout"
            className="h-8 w-44 text-(length:--text-app-body)"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-(length:--text-app-meta) text-slate-500">起始时间</span>
          <Input
            type="datetime-local"
            value={form.after}
            onChange={(event) => update({ after: event.currentTarget.value })}
            className="h-8 w-52 text-(length:--text-app-body)"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-(length:--text-app-meta) text-slate-500">结束时间</span>
          <Input
            type="datetime-local"
            value={form.before}
            onChange={(event) => update({ before: event.currentTarget.value })}
            className="h-8 w-52 text-(length:--text-app-body)"
          />
        </label>
        {contentMode ? (
          <div className="flex items-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={locate.isPending || parseLocalDateTime(applied.after || form.after) === undefined}
              onClick={() => shift("earlier")}
              title="把当前区间整体往前挪一个区间的长度，并重新扫描"
            >
              ← 再往前
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={locate.isPending || parseLocalDateTime(applied.after || form.after) === undefined}
              onClick={() => shift("later")}
              title="把当前区间整体往后挪一个区间的长度，并重新扫描"
            >
              再往后 →
            </Button>
          </div>
        ) : null}
        <Button type="submit" size="sm" disabled={Boolean(issue) || locate.isPending}>
          {locate.isPending && !page ? "扫描中…" : "定位"}
        </Button>
        {form.key || form.content || form.after || form.before ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setForm(EMPTY_LOCATE_FORM);
              setSubmitted(EMPTY_LOCATE_FORM);
              setPage(undefined);
              setNotice(null);
            }}
          >
            清空
          </Button>
        ) : null}
        <span className="w-full text-(length:--text-app-meta) text-slate-500">
          {issue ??
            (contentMode
              ? appliedRange
                ? `按内容扫描会把每条消息体解出来逐字比对，单次上限 5000 条，所以只认时间区间。本次区间：${appliedRange}（只填一端会自动补成等长窗口）`
                : "按内容扫描要把每条消息体解出来逐字比对，单次上限 5000 条，因此必须配时间区间：只填一端会自动补成等长窗口。"
              : "顺序读取，一次最多返回 200 条；只给时间区间时会同时从两端各扫一份。")}
        </span>
      </form>

      {locate.error ? (
        <div className="flex items-center gap-2 px-3 py-2 text-(length:--text-app-body) text-rose-700">
          <span>{errorMessage(locate.error)}</span>
          <Button size="sm" variant="ghost" onClick={page ? resume : () => start()}>
            重试
          </Button>
        </div>
      ) : null}

      {page ? (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2 text-(length:--text-app-body) text-slate-500">
            <span>
              {describeScanProgress({
                scanned: page.totalScanned,
                hits: page.totalHits,
                pages: page.pages,
                exhausted: !page.cursor,
              })}
            </span>
            {page.resumedFrom ? (
              <span className="text-slate-500">{page.resumedFrom}</span>
            ) : null}
            {page.contentBudget ? (
              <span className="text-amber-700">{page.contentBudget}</span>
            ) : null}
            {page.truncated ? (
              <span className="text-amber-700">
                已达本轮扫描上限，更早/更晚的消息还没读到，请收窄时间区间或继续扫描
              </span>
            ) : null}
            <span className="text-slate-500">{page.note}</span>
          </div>

          <HitTimeline items={page.items} range={appliedRangeMs} />

          {notice ? <p className="px-3 py-1 text-(length:--text-app-meta) text-slate-500">{notice}</p> : null}

          {page.items.length ? (
            <VirtualList
              items={page.items}
              itemHeight={ROW_HEIGHT}
              className="min-h-0 flex-1 overflow-auto"
              renderItem={(message) => (
                <LocateRow key={message.id} message={message} onClick={() => onSelect(message)} />
              )}
            />
          ) : (
            <p className="p-4 text-(length:--text-app-title) text-slate-500">
              已扫描 {formatNumber(page.totalScanned)} 条消息，没有命中
              {page.truncated ? "（扫描被截断，较早的消息还没读到）" : ""}
            </p>
          )}

          <div className="flex items-center gap-3 border-t border-slate-200 px-3 py-2">
            {page.cursor ? (
              <Button size="sm" variant="secondary" disabled={!canResume} onClick={resume}>
                {locate.isPending ? "扫描中…" : "继续扫描（沿上次停下的位置）"}
              </Button>
            ) : (
              <span className="text-(length:--text-app-meta) text-slate-500">
                已经扫到日志尽头，没有更多可读了
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="p-4 text-(length:--text-app-title) text-slate-500">
          {submittedEmpty
            ? "填写 key、内容片段或时间区间后点「定位」。定位是从指定位置开始顺序读取，不是全文检索。"
            : "正在等待定位结果…"}
        </p>
      )}
    </div>
  );
}

function LocateRow({ message, onClick }: { message: MessageSummary; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ height: ROW_HEIGHT }}
      className="flex w-full items-center gap-3 border-b border-slate-200 px-3 text-left text-(length:--text-app-body) hover:bg-slate-100"
    >
      <span className="w-40 shrink-0 truncate text-slate-500">
        {formatTimestamp(message.timestamp)}
      </span>
      <span className="w-16 shrink-0 text-slate-500">
        {message.partition !== undefined ? `P${message.partition}` : "-"}
      </span>
      <span className="w-20 shrink-0 text-slate-500">{formatNumber(message.offset)}</span>
      <span className="w-32 shrink-0 truncate text-info">{message.key ?? "-"}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-slate-800">{message.preview}</span>
      <span className="w-16 shrink-0 text-right text-slate-500">{formatBytes(message.size)}</span>
    </button>
  );
}

/**
 * 命中时间分布：把区间均分成若干段，每段一根柱子。
 *
 * 只画有命中的比例，不画消息总量——面板拿不到「这段区间里有多少条消息」，
 * 画一条假的分母比不画更糟。所以它回答的是「命中集中在哪一段」，
 * 而不是「命中有多密」。这也正是排查时想知道的：如果全挤在最后两根柱子上，
 * 该做的是把区间收窄到那一段，而不是继续往前翻。
 */
function HitTimeline({
  items,
  range,
}: {
  items: MessageSummary[];
  range?: [number, number];
}) {
  if (!range) return null;
  const buckets = bucketHits(items, range[0], range[1]);
  if (!buckets.length) return null;
  const peak = Math.max(...buckets.map((bucket) => bucket.hits));
  if (peak === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-b border-slate-200 px-3 py-2">
      <div className="flex h-6 items-end gap-0.5" role="img" aria-label="命中在时间区间内的分布">
        {buckets.map((bucket) => (
          <div
            key={bucket.start}
            title={`${formatTimestamp(bucket.start)} ~ ${formatTimestamp(bucket.end)}：${bucket.hits} 条`}
            className="flex-1 rounded-sm bg-indigo-400"
            style={{ height: `${Math.max(2, Math.round((bucket.hits / peak) * 24))}px` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-(length:--text-app-micro) text-slate-500">
        <span>{formatTimestamp(range[0])}</span>
        <span>命中集中在哪一段：柱子越高的那一格，越值得把区间收窄过去</span>
        <span>{formatTimestamp(range[1])}</span>
      </div>
    </div>
  );
}
