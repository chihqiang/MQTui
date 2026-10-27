import { NavLink, useParams } from "react-router";

import { useCloseConnection, useConnections } from "@/hooks/use-connections";
import { cn } from "@/lib/cn";
import { IconClose } from "@/lib/icons";
import { connectionPath } from "@/lib/nav";
import { disconnectLabel } from "@/lib/reconnect";

/**
 * 极简档的侧栏：只剩连接的首字母圆点。
 *
 * 收起的目的从来不是「少看几个字」，而是把宽度让给表格 —— 队列名和主题名
 * 动辄二三十个字符，横向空间比导航更值钱。
 *
 * 首字母相同是常态（`kafka-prod` / `kafka-test` 都是 K），所以圆点必须带
 * `title`（hover 能看到全名）而不能承担唯一识别责任；顶部栏另外给了一个
 * 「N 个连接」的出口作为退路。
 *
 * 断开在这里只能做成「第二动作」：圆点太小，叉号排进布局会把首字母挤没。
 * 所以它是悬停 / 键盘聚焦时浮在右上角的一个小圆点，不占位，也不妨碍点击圆点本身。
 */
export function ConnectionRail() {
  const { connectionId } = useParams();
  const { data } = useConnections();
  const closeConnection = useCloseConnection();

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-slate-200 bg-white py-2">
      {data?.map((connection) => (
        <div key={connection.id} className="group/rail relative">
          <NavLink
            to={connectionPath(connection.id)}
            title={`${connection.name} · ${connection.endpoint}`}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg text-(length:--text-app-meta) font-semibold transition-colors",
              connectionId === connection.id
                ? "bg-indigo-600 text-white"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
            )}
          >
            {connection.name.slice(0, 1).toUpperCase()}
          </NavLink>
          <button
            type="button"
            onClick={() => closeConnection.mutate(connection.id)}
            disabled={closeConnection.isPending}
            aria-label={disconnectLabel(connection.name, closeConnection.isPending)}
            title={disconnectLabel(connection.name, closeConnection.isPending)}
            className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-white text-meta opacity-0 ring-1 ring-slate-200 transition-opacity group-hover/rail:opacity-100 hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100"
          >
            <IconClose size={10} />
          </button>
        </div>
      ))}
    </aside>
  );
}
