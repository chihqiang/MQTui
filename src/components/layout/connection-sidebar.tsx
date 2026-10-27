import { NavLink, useParams } from "react-router";

import { Badge } from "@/components/ui";
import { cn } from "@/lib/cn";
import { BROKER_LABEL, connectionPath } from "@/lib/nav";
import { useConnections } from "@/hooks/use-connections";

/** 左侧：已建立的连接列表。 */
export function ConnectionSidebar() {
  const { connectionId } = useParams();
  const { data, isLoading } = useConnections();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
        <span className="text-sm font-semibold tracking-wide">MQTui</span>
        <NavLink
          to="/"
          className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
        >
          新建连接
        </NavLink>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <p className="px-1 pb-1 text-[11px] uppercase tracking-wider text-slate-500">正在连接</p>
        {isLoading ? <p className="px-1 text-xs text-slate-500">加载中…</p> : null}
        {data?.length === 0 ? (
          <p className="px-1 text-xs text-slate-500">暂无连接</p>
        ) : null}

        <ul className="flex flex-col gap-0.5">
          {data?.map((connection) => (
            <li key={connection.id}>
              <NavLink
                to={connectionPath(connection.id)}
                className={cn(
                  "flex flex-col gap-0.5 rounded px-2 py-1.5 text-xs transition-colors",
                  connectionId === connection.id
                    ? "bg-slate-800 text-slate-100"
                    : "text-slate-400 hover:bg-slate-800/60",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{connection.name}</span>
                  <Badge tone={connection.kind === "kafka" ? "info" : "warning"}>
                    {BROKER_LABEL[connection.kind]}
                  </Badge>
                </span>
                <span className="truncate text-[11px] text-slate-500">{connection.endpoint}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
