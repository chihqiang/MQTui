import { useState } from "react";

import { Badge, Button, SectionTitle, StaleNotice } from "@/components/ui";
import { useLagTrend } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import {
  catchUpNote,
  formatDelta,
  formatRate,
  hasWorsening,
  missingNote,
  notablePartitions,
  summarize,
  trendIsTrustworthy,
  verdictOf,
  verdictText,
  verdictTone,
  windowWarning,
} from "@/lib/lag-trend";
import { LAG_PROGRESS_COLUMNS, LAG_TREND_DEFAULT_WINDOW_MS, LAG_TREND_WINDOWS } from "@/types/lag-trend";

/**
 * 消费组滞后趋势：读两次进度算差值。
 *
 * 详情里的滞后量是一次快照，快照回答不了排查时最先要问的那句 ——
 * **这个 12 万条是在往下走，还是刚涨上来**。同一秒的两份快照长得完全一样。
 *
 * 不自动刷新：一次采样必然等满一个窗口（默认 5 秒），自动重取等于让弹窗
 * 永远在等下一个请求。所以这里是「点一下，等一会儿，看一个方向」。
 */
export function LagTrendSection({
  connectionId,
  group,
}: {
  connectionId: string;
  group: string;
}) {
  const [windowMs, setWindowMs] = useState(LAG_TREND_DEFAULT_WINDOW_MS);
  // `undefined` = 还没开始采：用户打开弹窗只是想看成员，不该被拖住五秒。
  const [running, setRunning] = useState<number | undefined>(undefined);
  const sample = useLagTrend(connectionId, group, running);
  const report = sample.data;

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle
        extra={
          <span className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-0.5">
              {LAG_TREND_WINDOWS.map((option) => (
                <button
                  key={option.ms}
                  type="button"
                  onClick={() => setWindowMs(option.ms)}
                  className={
                    option.ms === windowMs
                      ? "rounded bg-white px-2 py-0.5 text-(length:--text-app-meta) text-slate-800 shadow-xs"
                      : "rounded px-2 py-0.5 text-(length:--text-app-meta) text-slate-500 hover:text-slate-700"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button
              size="xs"
              variant="secondary"
              loading={sample.isFetching}
              onClick={() => setRunning(windowMs)}
              title="读两次该组的进度，用差值判断是在追还是越欠越多。这一步必然要等满所选窗口"
            >
              {sample.isFetching ? "采样中…" : report ? "重新采样" : "采样趋势"}
            </Button>
          </span>
        }
      >
        滞后趋势
      </SectionTitle>

      {sample.error && report ? (
        <StaleNotice
          message={failureText("重新采样", errorMessage(sample.error), group)}
          onRetry={() => setRunning(windowMs)}
        >
          下面是上一次采样算出的结果
        </StaleNotice>
      ) : null}
      {sample.error && !report ? (
        <p className="text-(length:--text-app-body) text-rose-700">
          {failureText("采样趋势", errorMessage(sample.error), group)}
        </p>
      ) : null}

      {report ? (
        <TrendReport report={report} />
      ) : !sample.error ? (
        <p className="text-(length:--text-app-body) text-slate-600">
          点「采样趋势」读两次进度，看滞后是在往下走，还是越欠越多。
          <span className="text-slate-500">
            {" "}
            会等满所选窗口，不落盘 —— 关掉窗口这些数字就没了。
          </span>
        </p>
      ) : null}
    </section>
  );
}

function TrendReport({
  report,
}: {
  report: NonNullable<ReturnType<typeof useLagTrend>["data"]>;
}) {
  const verdict = verdictOf(report.verdict);
  const trustworthy = trendIsTrustworthy(report.window);
  const warning = windowWarning(report.window);
  const notable = notablePartitions(report);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-(length:--text-app-body)">
        <Badge tone={verdict.tone}>{verdict.label}</Badge>
        <Metric label="消费速率" value={formatRate(report.consumeRate)} muted={!trustworthy} />
        <Metric label="窗口内消费" value={`${formatNumber(report.consumed)} 条`} muted={!trustworthy} />
        <Metric label="窗口内写入" value={`${formatNumber(report.produced)} 条`} muted={!trustworthy} />
      </div>

      {warning ? <p className="text-(length:--text-app-body) text-amber-700">{warning}</p> : null}

      <p className="text-(length:--text-app-body) text-slate-600">{summarize(report)}</p>

      {/* 恶化的分区才是排查的入口：全局结论说「越欠越多」不告诉你是哪几个分区。 */}
      {hasWorsening(report) && notable.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-(length:--text-app-meta) text-slate-500">
            先看这几个分区：
          </span>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {notable.map((item) => (
              <li
                key={`${item.topic}-${item.partition}`}
                className="flex items-center gap-1.5 text-(length:--text-app-meta)"
              >
                <span className="font-mono text-slate-700">
                  {item.topic}/P{item.partition}
                </span>
                <Badge tone={verdictTone(item.verdict)}>{verdictText(item.verdict)}</Badge>
                <span className="text-slate-500">{formatDelta(item.lagDelta)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.partitions.length ? (
        <div className="max-h-60 overflow-auto rounded border border-slate-200">
          <table className="w-full text-left text-(length:--text-app-body)">
            <thead className="text-(length:--text-app-meta) font-medium uppercase tracking-wide text-secondary">
              <tr className="border-b border-slate-200">
                {LAG_PROGRESS_COLUMNS.map((column) => (
                  <th key={column.key} className="px-2 py-1.5 font-normal">
                    {column.label}
                  </th>
                ))}
                <th className="px-2 py-1.5 font-normal">判定</th>
              </tr>
            </thead>
            <tbody>
              {report.partitions.map((item) => (
                <tr
                  key={`${item.topic}-${item.partition}`}
                  className="border-b border-slate-200 last:border-0"
                >
                  <td className="px-2 py-1.5 font-mono text-slate-800">
                    {item.topic}/P{item.partition}
                  </td>
                  <td className="px-2 py-1.5 text-slate-500">{formatNumber(item.lagBefore)}</td>
                  <td className="px-2 py-1.5 text-slate-700">{formatNumber(item.lagAfter)}</td>
                  <td className="px-2 py-1.5 text-slate-500">{formatDelta(item.lagDelta)}</td>
                  <td className="px-2 py-1.5 text-slate-500">{formatNumber(item.consumed)}</td>
                  <td className="px-2 py-1.5">
                    <Badge tone={verdictTone(item.verdict)}>{verdictText(item.verdict)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-(length:--text-app-body) text-slate-500">
          {report.verdict === "noBaseline"
            ? "这个组还没有提交过位点，没有可比较的量。"
            : "窗口内所有分区的滞后都没有变化。"}
        </p>
      )}

      {[missingNote(report), catchUpNote(report)]
        .filter((item): item is string => Boolean(item))
        .map((item) => (
          <p key={item} className="text-(length:--text-app-meta) text-slate-500">
            {item}
          </p>
        ))}
    </div>
  );
}

function Metric({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-(length:--text-app-meta) text-slate-500">{label}</span>
      <span className={muted ? "text-slate-500" : "font-medium text-slate-800"}>{value}</span>
    </span>
  );
}
