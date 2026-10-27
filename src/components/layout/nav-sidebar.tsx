import { useEffect } from "react";
import { NavLink, useLocation, useParams } from "react-router";

import { useConnections } from "@/hooks/use-connections";
import { useCapabilities } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { NAV_GROUP_LABEL, groupNavItems } from "@/lib/layout";
import { buildNavItems, connectionPath, type NavItem } from "@/lib/nav";
import { useSessionStore } from "@/stores";

/**
 * 菜单：由当前连接的能力动态生成，Kafka 与 RabbitMQ 的菜单因此天然不同。
 *
 * 两档形态共用一个组件，差别只在要不要画分组标题：
 * - `grouped`：按用途分段（消息 / 观测 / 配置），13 项里一眼找到日常页；
 * - `classic`：平铺一列，宽度最小，适合菜单本来就只有个位数的 Kafka。
 *
 * 分组规则是纯函数（`lib/layout.ts`），这里只负责把它画出来 ——
 * 「哪一项属于哪一组」不该散落在 JSX 里。
 */
export function NavSidebar({ grouped }: { grouped: boolean }) {
  const { connectionId } = useParams();
  const location = useLocation();
  const { data: connections } = useConnections();
  const setActiveConnection = useSessionStore((state) => state.setActiveConnection);
  const connection = connections?.find((item) => item.id === connectionId);
  const capabilities = useCapabilities(connection?.kind);

  // URL 是唯一事实来源：进入某个连接的任何子路由时同步到 store。
  useEffect(() => {
    setActiveConnection(connectionId ?? null);
  }, [connectionId, setActiveConnection]);

  if (!connection) return null;

  // 子路由（如 `topics/:topicName`）不在菜单里，用 pathname 前缀判断高亮，
  // 否则用户进详情页会看到菜单全灭、以为连接断开了。
  const currentPath = location.pathname;
  const items = buildNavItems(capabilities);

  return (
    <nav className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-slate-800 p-2">
      {grouped ? (
        groupNavItems(items).map((section) => (
          <div key={section.group} className="flex flex-col gap-0.5">
            {/* 只分出一项的组不画标题：为一个菜单项加一行小标题，
                换来的只是多一层缩进和一次视线跳跃。 */}
            {section.items.length > 1 ? (
              <p className="px-2 pt-1.5 pb-0.5 text-(length:--text-app-micro) tracking-wider text-slate-600 uppercase">
                {NAV_GROUP_LABEL[section.group]}
              </p>
            ) : null}
            {section.items.map((item) => (
              <NavItemLink
                key={item.capability}
                item={item}
                connectionId={connection.id}
                currentPath={currentPath}
              />
            ))}
          </div>
        ))
      ) : (
        items.map((item) => (
          <NavItemLink
            key={item.capability}
            item={item}
            connectionId={connection.id}
            currentPath={currentPath}
          />
        ))
      )}
    </nav>
  );
}

function NavItemLink({
  item,
  connectionId,
  currentPath,
}: {
  item: NavItem;
  connectionId: string;
  currentPath: string;
}) {
  const target = connectionPath(connectionId, item.capability);
  return (
    <NavLink
      to={target}
      title={item.description}
      className={cn(
        "rounded px-2 py-1.5 text-sm whitespace-nowrap transition-colors",
        isSectionActive(currentPath, target)
          ? "bg-selection/20 text-info"
          : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
      )}
    >
      {item.label}
    </NavLink>
  );
}

/** 当前路径是否属于某个菜单项（含它的子路由）。 */
function isSectionActive(current: string, target: string): boolean {
  return current === target || current.startsWith(`${target}/`);
}
