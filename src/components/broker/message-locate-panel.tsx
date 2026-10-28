import { useEffect, useRef, useState } from "react";

import { Button, Input, VirtualList } from "@/components/ui";
import {
  LOCATE_LIMIT,
  appendPage,
  bucketHits,
  describeScanProgress,
  useMessageLocate,
  type LocatePage,
} from "@/hooks/use-message-locate";
import { useLocateControls } from "@/hooks/use-locate-controls";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import {
  buildLocateRequest,
  EMPTY_LOCATE_FORM,
  isLocateFormEmpty,
  locateFormIssue,
  parseLocalDateTime,
  withFallbackKey,
  type LocateForm,
} from "@/lib/message-locate";
import { MESSAGE_ROW_HEIGHT } from "@/types/message";
import type { MessageLocatePanelProps, MessageSummary } from "@/types";

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
export function MessageLocatePanel({ connectionId, target, onSelect, initialKey }: MessageLocatePanelProps) {
  const [form, setForm] = useState<LocateForm>(EMPTY_LOCATE_FORM);
  // 只有点过「定位」才真正提交条件：边输入边扫会把集群当成自己的打字机。
  const [submitted, setSubmitted] = useState<LocateForm>(EMPTY_LOCATE_FORM);
  const [page, setPage] = useState<LocatePage | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const locate = useMessageLocate();
  // 实际下发的区间。内容搜索会在发请求前补齐区间，这里记下补齐后的结果，
  // 让「往前挪一小时」这类操作有确定的目标，而不是基于用户看到的半个区间去猜。
  const [applied, setApplied] = useState<LocateForm>(EMPTY_LOCATE_FORM);

  /**
   * 带进来的 key：变了就填进表单并立刻开扫（点的是「继续找」，不是「帮我填好再点一次」）。
   *
   * 用「上一次吃进去的 key」去重，而不是把它并进 `useState` 的初值：初值只在挂载时
   * 生效，之后再点另一个 key 就失灵；反过来每渲染一次都吃，用户自己改的输入会被盖掉。
   * 现场填好的其它条件要保留（`withFallbackKey`）—— 手上开着时间区间的人，
   * 要的是「在这个区间里按这个 key 找」。
   */
  const consumedKey = useRef<string | null>(null);
  const { mutate: runLocate } = locate;
  useEffect(() => {
    if (!initialKey || initialKey === consumedKey.current) return;
    consumedKey.current = initialKey;
    const next = withFallbackKey(form, initialKey);
    setForm(next);
    setSubmitted(next);
    setApplied(next);
    setPage(undefined);
    setNotice(null);
    const request = buildLocateRequest(connectionId, target, next, LOCATE_LIMIT);
    if (request) runLocate(request, { onSuccess: (result) => setPage(appendPage(undefined, result)) });
    // 只认 initialKey 的变化：form 是现场输入，进了依赖数组就会每敲一个字重扫一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

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

  const { start, shift, resume } = useLocateControls({
    connectionId,
    target,
    locate,
    page,
    applied,
    submitted,
    setForm,
    setSubmitted,
    setApplied,
    setPage,
    setNotice,
  });

  const canResume = Boolean(page?.cursor) && !locate.isPending;

  return (
    <div className="flex h-full flex-col rounded-lg border border-slate-200">
      {/*
        表单区。四个字段各自是一个「标签 + 控件」的竖排盒子，`items-end`
        对齐的是这些盒子的底边 —— 控件底边确实齐了，但问题是标签和控件之间
        没有共同的节奏：标签行高随文字走，长一点的那个（「内容片段（须配
        时间区间）」）会把整行撑高，旁边三个字段就跟着下沉。这里给标签钉
        一行行高（`leading-4` + `truncate`），四个盒子才一样高。
      */}
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
          <span className="truncate text-(length:--text-app-meta) text-secondary">key（精确匹配）</span>
          <Input
            value={form.key}
            onChange={(event) => update({ key: event.currentTarget.value })}
            placeholder="如 order-1001"
            className="h-8 w-40 text-(length:--text-app-body)"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="truncate text-(length:--text-app-meta) text-secondary">内容片段（须配时间区间）</span>
          <Input
            value={form.content}
            onChange={(event) => update({ content: event.currentTarget.value })}
            placeholder="如 timeout"
            className="h-8 w-40 text-(length:--text-app-body)"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="truncate text-(length:--text-app-meta) text-secondary">起始时间</span>
          <Input
            type="datetime-local"
            value={form.after}
            onChange={(event) => update({ after: event.currentTarget.value })}
            className="h-8 w-48 text-(length:--text-app-body)"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="truncate text-(length:--text-app-meta) text-secondary">结束时间</span>
          <Input
            type="datetime-local"
            value={form.before}
            onChange={(event) => update({ before: event.currentTarget.value })}
            className="h-8 w-48 text-(length:--text-app-body)"
          />
        </label>
        {/*
          从消费进度找：位点之后的日志才是「刚出问题的那段」。
          它是个开关而不是默认行为 —— 位点之前的消息这次搜不到，
          这件事必须由用户自己点头。
        */}
        <label
          className="flex flex-col gap-1"
          title="从该消费组已提交的位点往后找；位点之前的消息这次不会被搜到"
        >
          <span className="truncate text-(length:--text-app-meta) text-secondary">起点</span>
          <span className="flex h-8 items-center gap-1.5">
            <input
              type="checkbox"
              checked={form.fromCommitted}
              onChange={(event) => update({ fromCommitted: event.currentTarget.checked })}
              className="size-3.5 accent-indigo-600"
            />
            <Input
              value={form.group}
              onChange={(event) => update({ group: event.currentTarget.value })}
              placeholder="消费组名"
              aria-label="用哪个消费组的进度当起点"
              className="h-8 w-32 text-(length:--text-app-body)"
            />
          </span>
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
              : form.fromCommitted && form.after.trim() === ""
                ? "顺序读取，一次最多返回 200 条；本次从该消费组已提交的位点往后扫，位点之前的消息不会被搜到。"
                : "顺序读取，一次最多返回 200 条；只给时间区间时会同时从两端各扫一份。勾上「起点」可以从某个消费组的进度往后扫。")}
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
            {/*
              没有时间戳的那批单独说一句。它们符合 key / 内容条件，却永远进不了
              时间区间 —— 和「扫得不够多」是两件事，混进 `truncated` 的措辞里
              会让人一遍遍点「继续扫描」。
            */}
            {page.undated ? <span className="text-amber-700">{page.undated}</span> : null}
            {/*
              起点读不到时单独说一句：反查失败会退回分区最早位置，
              这次扫描读得比预期多得多，条数上限很可能在命中之前就到了。
              不说，用户会把「没有命中」当成「不存在」。
            */}
            {page.window ? <span className="text-amber-700">{page.window}</span> : null}
            <span className="text-slate-500">{page.note}</span>
          </div>

          <HitTimeline items={page.items} range={appliedRangeMs} />

          {notice ? <p className="px-3 py-1 text-(length:--text-app-meta) text-slate-500">{notice}</p> : null}

          {page.items.length ? (
            <VirtualList
              items={page.items}
              itemHeight={MESSAGE_ROW_HEIGHT}
              className="min-h-0 flex-1 overflow-auto"
              renderItem={(message) => (
                <LocateRow key={message.id} message={message} onClick={() => onSelect(message)} />
              )}
            />
          ) : (
            <p className="p-4 text-(length:--text-app-title) text-slate-500">
              已扫描 {formatNumber(page.totalScanned)} 条消息，没有命中
              {page.truncated ? "（扫描被截断，较早的消息还没读到）" : ""}
              {page.undated ? "（另有满足条件但没有时间戳的消息，见上方说明）" : ""}
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
      style={{ height: MESSAGE_ROW_HEIGHT }}
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
