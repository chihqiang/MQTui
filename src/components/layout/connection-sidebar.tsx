import { NavLink, useParams } from "react-router";

import { Badge } from "@/components/ui";
import { useCloseConnection, useConnections } from "@/hooks/use-connections";
import { cn } from "@/lib/cn";
import { IconClose } from "@/lib/icons";
import { BROKER_LABEL, connectionPath } from "@/lib/nav";
import { disconnectLabel } from "@/lib/reconnect";
import { brokerTone } from "@/lib/visual";

/**
 * 连接列表（分组 / 平铺两档共用的左侧第一列）。
 *
 * 品牌、命令面板、新建连接、收起按钮都已上移到顶部栏 —— 它们属于整个应用，
 * 不属于「连接列表」。这里只剩连接本身，纵向空间全给列表。
 *
 * 常驻而不做成「下拉切换」：面板工具的典型用法是两个集群来回对照，
 * 切换成本要压到一次点击。
 *
 * 每条连接后面挂一个断开按钮，悬停才出现：列表里可能同时挂着五条连接，
 * 五个常亮的叉号会让「切过去」这个主操作看起来和「断掉它」一样重要。
 */
export function ConnectionSidebar() {
  const { connectionId } = useParams();
  const { data, isLoading } = useConnections();
  const closeConnection = useCloseConnection();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="min-h-0 flex-1 overflow-auto px-2.5 py-4">
        <p className="px-2 pb-2 text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase">
          连接
        </p>
        {isLoading ? <p className="px-2 text-(length:--text-app-body) text-meta">加载中…</p> : null}
        {data?.length === 0 ? (
          <p className="px-2 text-(length:--text-app-meta) leading-relaxed text-meta">
            还没有连接。点右上角的 + 新建一条。
          </p>
        ) : null}

        <ul className="flex flex-col gap-1">
          {data?.map((connection) => {
            const active = connectionId === connection.id;
            return (
              <li key={connection.id} className="group/row relative">
                <NavLink
                  to={connectionPath(connection.id)}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg px-2.5 py-2 pr-8 text-(length:--text-app-body) transition-colors",
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
                {/* 悬停 / 键盘聚焦时才出现：断开是「收场」，不该和「切过去」抢同一层的注意力。
                    用 `focus-within` 是为了让 Tab 到这一行时它也现身，否则键盘用户摸不到。 */}
                <button
                  type="button"
                  onClick={() => closeConnection.mutate(connection.id)}
                  disabled={closeConnection.isPending}
                  aria-label={disconnectLabel(connection.name, closeConnection.isPending)}
                  title={disconnectLabel(connection.name, closeConnection.isPending)}
                  className="absolute top-2 right-1.5 flex size-6 items-center justify-center rounded-md text-meta opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 disabled:opacity-50"
                >
                  <IconClose size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
