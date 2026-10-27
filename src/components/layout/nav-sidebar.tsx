import { useEffect } from "react";
import { NavLink, useParams } from "react-router";

import { cn } from "@/lib/cn";
import { useConnections } from "@/hooks/use-connections";
import { useCapabilities } from "@/hooks/use-plugin-kinds";
import { buildNavItems, connectionPath } from "@/lib/nav";
import { useSessionStore } from "@/stores";

/** 菜单：由当前连接的能力动态生成，Kafka 与 RabbitMQ 的菜单因此天然不同。 */
export function NavSidebar() {
  const { connectionId } = useParams();
  const { data: connections } = useConnections();
  const setActiveConnection = useSessionStore((state) => state.setActiveConnection);
  const connection = connections?.find((item) => item.id === connectionId);
  const capabilities = useCapabilities(connection?.kind);

  // URL 是唯一事实来源：进入某个连接的任何子路由时同步到 store。
  useEffect(() => {
    setActiveConnection(connectionId ?? null);
  }, [connectionId, setActiveConnection]);

  if (!connection) return null;

  return (
    <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-slate-800 p-2">
      {buildNavItems(capabilities).map((item) => (
        <NavLink
          key={item.capability}
          to={connectionPath(connection.id, item.capability)}
          className={({ isActive }) =>
            cn(
              "rounded px-2 py-1.5 text-sm transition-colors",
              isActive ? "bg-sky-600/20 text-sky-200" : "text-slate-400 hover:bg-slate-800/60",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
