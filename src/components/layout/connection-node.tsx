import { NavLink, useLocation } from "react-router";

import { useConnectionFold } from "@/hooks/use-sidebar-folds";
import { useCapabilities } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { IconChevronDown, IconChevronRight, IconClose, IconServer } from "@/lib/icons";
import { BROKER_LABEL, brokerIcon, buildNavItems, connectionPath, type NavItem } from "@/lib/nav";
import { disconnectLabel } from "@/lib/reconnect";
import { BROKER_TONE_CLASS, brokerTone } from "@/lib/visual";
import type { BrokerKind, ConnectionSummary } from "@/types";

/**
 * 侧栏的一行连接，外加它自己的页面菜单。
 *
 * ```
 * ▾ [K] kafka-prod      ⌫      ← 点箭头收起 / 摊开，点名字进工作区
 *      10.0.1.12:9092
 *   ├ 概览
 *   ├ 主题
 *   └ 消费组 …
 * ```
 *
 * 三处刻意的取舍：
 *
 * 1. **折叠状态归行所有**。`useConnectionFold` 就在这一行里，点箭头换的是
 *    这一行自己的 state。以前侧栏持有一个折叠集合、行按 key 去查 —— 集合
 *    变了连接列表还是原来那个对象，React 认为没变化，箭头点了不动。
 * 2. **箭头是行首一块独立的命中区，比字形大**。11px 的箭头配 20px 的按钮，
 *    再加 `-ml` 把命中区往左探出去：可点的范围不该等于图形画多大。
 * 3. **当前所在的连接不参与折叠**。站在里面却看不见菜单，等于把路标
 *    收进抽屉；所以箭头在选中行上是禁用的，且永远是摊开态。
 */
export function ConnectionNode({
  connection,
  active,
  onDisconnect,
  disconnecting,
}: {
  connection: ConnectionSummary;
  active: boolean;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  const { expanded, toggle } = useConnectionFold(connection);
  const open = active || expanded;

  return (
    <div className="relative">
      <div
        className={cn(
          "group/row relative flex items-center rounded-lg pr-1 transition-colors",
          active ? "bg-indigo-50/80" : "hover:bg-slate-50",
        )}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={active}
          aria-expanded={open}
          aria-label={
            active
              ? `${connection.name} 是当前连接，页面菜单保持展开`
              : `${open ? "收起" : "展开"} ${connection.name} 的页面菜单`
          }
          title={
            active
              ? "当前连接的页面菜单保持展开"
              : `${open ? "收起" : "展开"} ${connection.name} 的页面菜单`
          }
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded text-meta transition-colors",
            active ? "text-indigo-500" : "text-meta hover:bg-white hover:text-slate-900",
          )}
        >
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>

        <NavLink
          to={connectionPath(connection.id)}
          title={`${connection.name} · ${connection.endpoint}`}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1"
        >
          {/* 类型徽标替掉了原来那条 2px 竖线：竖线只说颜色，徽标同时给形状
              （齿轮 / 耳朵）和颜色 —— 认得出 Kafka 与 RabbitMQ，不用先记住
              「琥珀是哪个」。徽标不参与选中态，选中态仍是行底色 + 名字变色。 */}
          <BrokerBadge kind={connection.kind} size={24} iconSize={13} dim={!active} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-(length:--text-app-body) font-medium",
                active ? "text-indigo-800" : "text-slate-700",
              )}
            >
              {connection.name}
            </span>
            <span className="truncate font-mono text-(length:--text-app-meta) text-meta">
              {connection.endpoint}
            </span>
          </span>
        </NavLink>

        {/* 「收场」只在悬停 / 键盘聚焦时出现：常亮的话，它会和「切过去」抢
            同一层的注意力，而一条连接一进侧栏就摆着个「断开」也很吓人。 */}
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          aria-label={disconnectLabel(connection.name, disconnecting)}
          title={disconnectLabel(connection.name, disconnecting)}
          className="flex size-5.5 shrink-0 items-center justify-center rounded text-meta opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-rose-50 hover:text-rose-600 group-focus-within/row:opacity-100 disabled:opacity-50"
        >
          <IconClose size={11} />
        </button>
      </div>

      {open ? <ConnectionPages connectionId={connection.id} kind={connection.kind} active={active} /> : null}
    </div>
  );
}

/**
 * 一条连接的页面菜单（第二层，也是最末一层）。
 *
 * 一列平铺，不加「消息 / 观测 / 配置」分组标题 —— 那几行小标题长得像菜单
 * 项却点不动，光标划过任何一行都有反馈，唯独划过它没有，人先怀疑的是自己
 * 点错了位置，而不是「这里本来就不该点」。
 *
 * 非当前连接的菜单淡一档，让「我正在看的这一份」仍然可辨。
 */
function ConnectionPages({
  connectionId,
  kind,
  active,
}: {
  connectionId: string;
  kind: BrokerKind;
  active: boolean;
}) {
  const location = useLocation();
  const capabilities = useCapabilities(kind);
  const items = buildNavItems(capabilities);

  if (items.length === 0) return null;

  return (
    // `ml-[18px]` 对齐到连接行那个箭头的竖轴；右边收 4px 是给悬停背景留的余量 ——
    // 菜单项贴着侧栏内边距画背景时，右边会被裁成齐口，看着像溢出了。
    <ul
      className={cn(
        "mt-0.5 mb-1 ml-[18px] flex flex-col gap-px border-l border-slate-200 pr-1 pl-2",
        !active && "opacity-70",
      )}
    >
      {items.map((item) => (
        <li key={item.capability}>
          <PageLink item={item} connectionId={connectionId} pathname={location.pathname} />
        </li>
      ))}
    </ul>
  );
}

function PageLink({
  item,
  connectionId,
  pathname,
}: {
  item: NavItem;
  connectionId: string;
  pathname: string;
}) {
  const target = connectionPath(connectionId, item.capability);
  const active = pathname === target || pathname.startsWith(`${target}/`);
  const { Icon } = item;

  return (
    <NavLink
      to={target}
      title={item.description}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-(length:--text-app-body) whitespace-nowrap transition-colors",
        active
          ? "bg-white font-medium text-indigo-700 shadow-xs ring-1 ring-slate-200"
          : "text-slate-600 hover:bg-white hover:text-slate-900",
      )}
    >
      <Icon size={13} className={active ? "text-indigo-600" : "text-meta"} />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

/**
 * 连接行左侧的类型徽标：浅色底 + 身份色图标。
 *
 * `dim` 让非当前连接淡一档。不是「灰掉」—— 类型信息任何时候都该读得出来，
 * 只是在当前连接上它才该和最深的文字同层。
 */
function BrokerBadge({
  kind,
  size = 24,
  iconSize = 13,
  dim = false,
}: {
  kind: string;
  size?: number;
  iconSize?: number;
  dim?: boolean;
}) {
  const Icon = brokerIcon(kind);
  const tone = brokerTone(kind);
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        tone === "neutral" ? "bg-slate-100 text-secondary" : BROKER_TONE_CLASS[tone].tint,
        dim && "opacity-60",
      )}
    >
      {Icon ? <Icon size={iconSize} /> : <IconServer size={iconSize} />}
      <span className="sr-only">{BROKER_LABEL[kind as BrokerKind] ?? kind}</span>
    </span>
  );
}
