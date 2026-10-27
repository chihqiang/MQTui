import { NavLink, useParams } from "react-router";

import { useConnections } from "@/hooks/use-connections";
import { cn } from "@/lib/cn";
import { connectionPath } from "@/lib/nav";

/**
 * 极简档的侧栏：只剩连接的首字母圆点。
 *
 * 收起的目的从来不是「少看几个字」，而是把宽度让给表格 —— 队列名和主题名
 * 动辄二三十个字符，横向空间比导航更值钱。
 *
 * 首字母相同是常态（`kafka-prod` / `kafka-test` 都是 K），所以圆点必须带
 * `title`（hover 能看到全名）而不能承担唯一识别责任；顶部栏另外给了一个
 * 「N 个连接」的出口作为退路。
 */
export function ConnectionRail() {
  const { connectionId } = useParams();
  const { data } = useConnections();

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-slate-200 bg-white py-2">
      {data?.map((connection) => (
        <NavLink
          key={connection.id}
          to={connectionPath(connection.id)}
          title={`${connection.name} · ${connection.endpoint}`}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-(length:--text-app-meta) font-semibold transition-colors",
            connectionId === connection.id
              ? "bg-indigo-600 text-white"
              : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
          )}
        >
          {connection.name.slice(0, 1).toUpperCase()}
        </NavLink>
      ))}
    </aside>
  );
}
