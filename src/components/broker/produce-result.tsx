import { Link } from "react-router";

import { cn } from "@/lib/cn";
import { formatBytes, formatTimestamp } from "@/lib/format";

/**
 * 一次发送的结果。
 *
 * 三种状态刻意分开，因为它们对下一步的含义完全不同：
 * - `success`：写进去了，可以接着去看；
 * - `warning`：**没拿到确认**（Kafka 超时一类），消息可能已经写进去 ——
 *   这时候说「失败」会让人原样重发，那正是制造重复消息；
 * - `danger`：确实失败，改完再发。
 */
export type ProduceResultTone = "success" | "warning" | "danger";

export interface ProduceResult {
  tone: ProduceResultTone;
  /** 一句话结论，例如「已投递到 orders」。 */
  title: string;
  /** 补充说明：后端原文、producer 提醒、队列数。 */
  detail?: string;
  /** 这次发出去的字节数。 */
  bytes: number;
  /** 发送完成的时间戳。 */
  at: number;
  /** 「查看这条消息」的去处；没有落点（比如发到了默认交换机）时不给按钮。 */
  viewPath?: string;
  /** 查看入口的文案，默认「查看这条消息」。 */
  viewLabel?: string;
}

const TONE_CLASS: Record<ProduceResultTone, string> = {
  success: "border-l-success text-slate-700",
  warning: "border-l-warning text-slate-700",
  danger: "border-l-danger text-slate-700",
};

const TITLE_CLASS: Record<ProduceResultTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * 结果条：发送之后留在页面上，直到下一次发送。
 *
 * 之前结果只有一条几秒后消失的 toast，「发了多少字节、落到哪、要不要去看一眼」
 * 全跟着一起消失 —— 而发消息这个动作十有八九紧接着就是「去消息页确认它到了」。
 */
export function ProduceResultRow({
  result,
  onClear,
}: {
  result: ProduceResult;
  /** 清空正文（目标与高级选项保留，方便接着发下一条）。 */
  onClear: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md border-l-2 bg-slate-50/70 px-3 py-2",
        TONE_CLASS[result.tone],
      )}
      // 结果条是「刚刚发生的事」，读屏也该主动播报一次。
      role="status"
      aria-live="polite"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-(length:--text-app-body)">
          <span className={cn("font-medium", TITLE_CLASS[result.tone])}>{result.title}</span>
          <span className="font-mono text-(length:--text-app-meta) text-meta">
            {formatBytes(result.bytes)} · {formatTimestamp(result.at)}
          </span>
        </p>
        {result.detail ? (
          <p className="mt-0.5 text-(length:--text-app-meta) whitespace-pre-wrap text-secondary">
            {result.detail}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {result.viewPath ? (
          <Link
            to={result.viewPath}
            className="rounded px-1.5 py-1 text-(length:--text-app-meta) text-indigo-600 transition-colors hover:bg-indigo-50"
          >
            {result.viewLabel ?? "查看这条消息"} →
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onClear}
          className="rounded px-1.5 py-1 text-(length:--text-app-meta) text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
        >
          清空正文
        </button>
      </div>
    </div>
  );
}
