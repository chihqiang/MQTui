import { useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui";
import { Button } from "@/components/ui/button";
import type { TopicThroughput } from "@/types/topic-throughput";
import { useTopicThroughput } from "@/hooks/use-topics";
import { formatNumber } from "@/lib/format";
import {
  busiest,
  formatThroughput,
  formatWindow,
  isIdle,
  rateIsTrustworthy,
  summarize,
  windowWarning,
} from "@/lib/throughput";

/** 采样间隔选项。太短算出来是噪音，太长等于页面卡死。 */
const WINDOWS: { value: number; label: string; hint: string }[] = [
  { value: 3000, label: "3 秒", hint: "最短，抖动大一点" },
  { value: 5000, label: "5 秒", hint: "默认，够看出是涨还是停" },
  { value: 10000, label: "10 秒", hint: "写入稀疏时更能看出趋势" },
  { value: 30000, label: "30 秒", hint: "慢速主题，但要等半分钟" },
];

const DEFAULT_WINDOW = 5000;

/**
 * 主题吞吐：读两次水位算差分。
 *
 * 为什么不自动刷新：一次采样必然等满一个窗口（默认 5 秒），自动重取等于
 * 让页面永远在等下一个请求。所以这里是「点一下，等一会儿，看一个数」。
 *
 * 累计水位回答不了「它现在是在涨还是在停」——`10 万条` 可能是刚写完，
 * 也可能是三天没人管。这一块只补这一个问题，不做长期趋势（那该上监控系统）。
 */
export function TopicThroughputCard({
  connectionId,
  topic,
}: {
  connectionId: string | undefined;
  topic: string;
}) {
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW);
  const sample = useTopicThroughput(connectionId);
  const report = sample.data;

  return (
    <Card>
      <CardHeader
        title="吞吐"
        extra={
          <>
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-0.5">
              {WINDOWS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  onClick={() => setWindowMs(option.value)}
                  className={
                    option.value === windowMs
                      ? "rounded bg-white px-2 py-0.5 text-(length:--text-app-meta) text-slate-800 shadow-xs"
                      : "rounded px-2 py-0.5 text-(length:--text-app-meta) text-slate-500 hover:text-slate-700"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={sample.isPending}
              onClick={() => sample.mutate({ topic, windowMs })}
              title="读两次分区水位，用差值除以时间。这一步必然要等满所选窗口"
            >
              {sample.isPending ? "采样中…" : "采样"}
            </Button>
          </>
        }
      />
      <CardBody className={report ? undefined : "flex flex-col gap-1"}>
        {report ? (
          <ThroughputReport report={report} />
        ) : (
          <>
            <p className="text-(length:--text-app-body) text-slate-600">
              累计水位看不出「现在是在涨还是在停」：点一次「采样」，读两次分区水位，
              用差值除以时间算出写入速率。
            </p>
            <p className="text-(length:--text-app-meta) text-slate-500">
              会等满所选窗口（当前 {formatWindow(windowMs)}）。不连 JMX、不落盘，
              关掉窗口这些数字就没了 —— 长期趋势该交给监控系统。
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function ThroughputReport({ report }: { report: TopicThroughput }) {
  const warning = windowWarning(report.window);
  const trustworthy = rateIsTrustworthy(report.window);
  const top = busiest(report);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="写入速率"
          value={formatThroughput(report.rate)}
          muted={!trustworthy}
          hint={`窗口 ${formatWindow(report.windowMs)}`}
        />
        <Metric label="窗口内写入" value={`${formatNumber(report.delta)} 条`} muted={!trustworthy} />
        <Metric
          label="最忙分区"
          value={top ? `P${top.partition}` : "—"}
          hint={top ? formatThroughput(top.rate) : "没有分区在增长"}
          muted={!trustworthy}
        />
        <Metric label="当前消息量" value={`${formatNumber(report.messages)} 条`} />
      </div>

      {warning ? (
        <p className="text-(length:--text-app-body) text-amber-700">{warning}</p>
      ) : null}

      {isIdle(report) ? (
        <p className="text-(length:--text-app-body) text-slate-600">
          窗口内没有新消息写入。消息量不为零说明写侧停了、消费侧可能还在追。
        </p>
      ) : null}

      {report.partitions.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-(length:--text-app-body)">
            <thead className="text-(length:--text-app-meta) font-medium uppercase tracking-wide text-secondary">
              <tr className="border-b border-slate-200">
                <th className="py-1.5 pr-4 font-normal">分区</th>
                <th className="py-1.5 pr-4 font-normal">速率</th>
                <th className="py-1.5 pr-4 font-normal">窗口内写入</th>
                <th className="py-1.5 font-normal">当前消息量</th>
              </tr>
            </thead>
            <tbody>
              {report.partitions.map((item) => (
                <tr key={item.partition} className="border-b border-slate-200 last:border-0">
                  <td className="py-1.5 pr-4 font-mono text-slate-800">P{item.partition}</td>
                  <td className={trustworthy ? "py-1.5 pr-4 text-slate-700" : "py-1.5 pr-4 text-slate-500"}>
                    {formatThroughput(item.rate)}
                  </td>
                  <td className="py-1.5 pr-4 text-slate-500">{formatNumber(item.delta)}</td>
                  <td className="py-1.5 text-slate-500">{formatNumber(item.messages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {report.notes?.length ? (
        <ul className="flex flex-col gap-1">
          {report.notes
            // 窗口提示已经单独渲染过一次，不重复。
            .filter((item) => item.key !== "idle" || !isIdle(report))
            .map((item) => (
              <li key={item.key} className="text-(length:--text-app-meta) text-slate-500">
                {item.value}
              </li>
            ))}
        </ul>
      ) : null}

      <p className="text-(length:--text-app-meta) text-slate-500">{summarize(report)}</p>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-(length:--text-app-meta) text-slate-500">{label}</span>
      <span
        className={
          muted
            ? "text-(length:--text-app-title) font-medium text-slate-500"
            : "text-(length:--text-app-title) font-medium text-slate-800"
        }
      >
        {value}
      </span>
      {hint ? <span className="text-(length:--text-app-meta) text-slate-500">{hint}</span> : null}
    </div>
  );
}
