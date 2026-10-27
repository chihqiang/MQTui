import { useMemo } from "react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useHealth } from "@/hooks/use-health";
import type { CheckStatus } from "@/types/health";

const STATUS_DOT: Record<CheckStatus, string> = {
  ok: "bg-emerald-400",
  failed: "bg-rose-400",
  unknown: "bg-slate-500",
};

const STATUS_TEXT: Record<CheckStatus, string> = {
  ok: "text-emerald-300",
  failed: "text-rose-300",
  unknown: "text-slate-400",
};

/**
 * 内容区顶部的健康条。
 *
 * 放在这里而不是概览页，是因为「管理 API 挂了」会同时影响队列、交换机、消息三页，
 * 用户不该每翻一页就重新发现一次。
 */
export function HealthBar({ connectionId }: { connectionId: string | undefined }) {
  const { data, isFetching, refetch } = useHealth(connectionId);

  const items = useMemo(() => data?.items ?? [], [data]);

  return (
    <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/40 px-4 py-1.5 text-[11px]">
      <span className="text-slate-500">健康</span>
      {items.length ? (
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          {items.map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-1.5" title={item.detail}>
              <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[item.status])} />
              <span className={STATUS_TEXT[item.status]}>{item.label}</span>
              {item.detail ? (
                <span className="max-w-72 truncate text-slate-500">{item.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <span className="flex-1 text-slate-500">
          {isFetching ? "探测中…" : "暂无探测结果"}
        </span>
      )}
      <Button size="sm" variant="ghost" disabled={isFetching} onClick={() => void refetch()}>
        重新探测
      </Button>
    </div>
  );
}
