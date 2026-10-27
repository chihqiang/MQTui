import { NavLink, useParams } from "react-router";

import { Badge } from "@/components/ui";
import { useConnections } from "@/hooks/use-connections";
import { cn } from "@/lib/cn";
import { BROKER_LABEL, connectionPath } from "@/lib/nav";
import { brokerTone } from "@/lib/visual";

/**
 * 连接列表（分组 / 平铺两档共用的左侧第一列）。
 *
 * 品牌、命令面板、新建连接、收起按钮都已上移到顶部栏 —— 它们属于整个应用，
 * 不属于「连接列表」。这里只剩连接本身，纵向空间全给列表。
 *
 * 常驻而不做成「下拉切换」：面板工具的典型用法是两个集群来回对照，
 * 切换成本要压到一次点击。
 */
export function ConnectionSidebar() {
  const { connectionId } = useParams();
  const { data, isLoading } = useConnections();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="min-h-0 flex-1 overflow-auto px-2 py-3">
        <p className="px-2 pb-1.5 text-(length:--text-app-micro) font-medium tracking-wider text-slate-400 uppercase">
          连接
        </p>
        {isLoading ? <p className="px-2 text-xs text-slate-400">加载中…</p> : null}
        {data?.length === 0 ? (
          <p className="px-2 text-(length:--text-app-meta) leading-relaxed text-slate-400">
            还没有连接。点右上角的 + 新建一条。
          </p>
        ) : null}

        <ul className="flex flex-col gap-0.5">
          {data?.map((connection) => {
            const active = connectionId === connection.id;
            return (
              <li key={connection.id}>
                <NavLink
                  to={connectionPath(connection.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-xs transition-colors",
                    active
                      ? "bg-indigo-50 text-indigo-900 ring-1 ring-indigo-100"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{connection.name}</span>
                    <Badge tone={brokerTone(connection.kind)}>
                      {BROKER_LABEL[connection.kind]}
                    </Badge>
                  </span>
                  <span className="truncate text-(length:--text-app-meta) text-meta">
                    {connection.endpoint}
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
