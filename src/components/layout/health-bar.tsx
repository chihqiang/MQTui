import { useState } from "react";

import { cn } from "@/lib/cn";
import { IconChevronDown, IconChevronRight, IconRefresh } from "@/lib/icons";
import { useHealth } from "@/hooks/use-health";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { statusBarHeight } from "@/lib/visual";
import type { CheckStatus } from "@/types/health";

/** 状态色：圆点、文字、边框共用一套，避免同一件事在三个地方三种颜色。 */
const STATUS_DOT: Record<CheckStatus, string> = {
  ok: "bg-success-fill",
  failed: "bg-danger-fill",
  unknown: "bg-slate-300",
};

const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: "text-success",
  failed: "text-danger",
  unknown: "text-secondary",
};

/**
 * 内容区顶部的健康条。
 *
 * 放在这里而不是概览页，是因为「管理 API 挂了」会同时影响队列、交换机、消息三页，
 * 用户不该每翻一页就重新发现一次。
 *
 * 折叠的意义：健康全绿时这行只占一条细线，把纵向空间还给表格；
 * 有异常才自动展开，并在折叠态上显示异常条数 —— 「3 项异常」比 3 个红点更好数。
 */
export function HealthBar({ connectionId }: { connectionId: string | undefined }) {
  const { data, isFetching, error, refetch } = useHealth(connectionId);
  const [expanded, setExpanded] = useState(false);

  const items = data?.items ?? [];
  const failed = items.filter((item) => item.status === "failed").length;
  const open = expanded || failed > 0;

  return (
    <div
      // 厚度是版面的决定：它常驻每页标题上方，厚一格就少一行表格。
      // 展开时不受此限 —— 用户主动点开的，就该给够高度。
      style={{ minHeight: open ? undefined : statusBarHeight() }}
      className={cn(
        "flex items-center gap-2 border-b border-slate-200 bg-white/80 px-3 py-1 text-(length:--text-app-meta)",
        // 折叠态要真能压到一条线：内容不换行，才不会被撑开。
        !open && "flex-nowrap overflow-hidden",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={open}
        className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-secondary transition-colors hover:bg-slate-100 hover:text-slate-900"
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span>健康</span>
      </button>

      {items.length === 0 ? (
        <span className="flex-1 text-secondary">{isFetching ? "探测中…" : "暂无探测结果"}</span>
      ) : open ? (
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5">
          {items.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-1.5" title={item.detail}>
              <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[item.status])} />
              <span className={STATUS_TEXT[item.status]}>{item.label}</span>
              {item.detail ? (
                <span className="max-w-72 truncate text-meta">{item.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-success">
          <span className="size-1.5 rounded-full bg-success-fill" />
          {items.length} 项正常
        </span>
      )}

      {/* 探测失败时把原因写在这儿，而不是弹 toast：toast 三秒就没了，
          而「管理 API 连不上」是持续状态，得一直看得见。 */}
      {error && !isFetching ? (
        <span
          className="max-w-72 min-w-0 truncate text-danger/90"
          title={failureText("探测连接健康", errorMessage(error))}
        >
          {failureText("探测连接健康", errorMessage(error))}
        </span>
      ) : null}

      <button
        type="button"
        onClick={() => void refetch()}
        disabled={isFetching}
        aria-label="重新探测"
        title="重新探测"
        className="shrink-0 rounded p-1 text-secondary transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
      >
        <IconRefresh className={isFetching ? "animate-spin" : undefined} size={12} />
      </button>
    </div>
  );
}
