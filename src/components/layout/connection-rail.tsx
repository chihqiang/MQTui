import { NavLink } from "react-router";

import { useCapabilities } from "@/hooks/use-plugin-kinds";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { cn } from "@/lib/cn";
import { RAIL_WIDTH } from "@/lib/layout";
import { buildNavItems, connectionPath } from "@/lib/nav";
import { brokerIdentity } from "@/lib/visual";

/**
 * 图标条：窄窗口（< 900px）下的侧栏。
 *
 * 只剩「当前连接的页面菜单」一行图标，链接、连接名、端点全都不显示：
 * 这个宽度下每 1px 都该给表格。连接之间的切换交给顶部栏的「N 个连接」
 * 入口 —— 一列图标里认不出 kafka-prod 和 kafka-test 的区别，那只是把
 * 选择变成了猜。
 *
 * 图标必须带 `title` 与 `aria-label`：形状是唯一识别物，当它认不出来时，
 * 悬停和读屏是仅剩的两条出路。
 */
export function ConnectionRail() {
  const { connection } = useActiveConnection();
  const capabilities = useCapabilities(connection?.kind);
  const items = buildNavItems(capabilities);

  return (
    <aside
      style={{ width: RAIL_WIDTH }}
      className="flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-slate-200 bg-white py-2"
    >
      {connection ? (
        <span
          title={`${connection.name} · ${connection.endpoint}`}
          className={cn(
            "mb-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-(length:--text-app-meta) font-bold",
            brokerIdentity(connection.kind) === "kafka"
              ? "bg-broker-kafka/15 text-broker-kafka"
              : "bg-broker-rabbitmq/15 text-broker-rabbitmq",
          )}
        >
          {connection.name.slice(0, 1).toUpperCase()}
        </span>
      ) : null}

      {connection
        ? items.map((item) => {
            const { Icon } = item;
            const target = connectionPath(connection.id, item.capability);
            return (
              <NavLink
                key={item.capability}
                to={target}
                title={item.label}
                aria-label={item.label}
                className={({ isActive }) =>
                  cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
                    isActive
                      ? "bg-indigo-600 text-white"
                      : "text-secondary hover:bg-slate-100 hover:text-slate-900",
                  )
                }
              >
                <Icon size={16} />
              </NavLink>
            );
          })
        : null}
    </aside>
  );
}
