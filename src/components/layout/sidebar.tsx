import { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useParams } from "react-router";

import { useCloseConnection, useConnections } from "@/hooks/use-connections";
import { useCapabilities } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import {
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconServer,
} from "@/lib/icons";
import { NAV_GROUP_LABEL, groupConnectionsByKind, groupNavItems } from "@/lib/layout";
import { BROKER_LABEL, brokerIcon, buildNavItems, connectionPath, type NavItem } from "@/lib/nav";
import { disconnectLabel } from "@/lib/reconnect";
import { BROKER_TONE_CLASS, brokerTone } from "@/lib/visual";
import { readCollapsedGroups, saveCollapsedGroups } from "@/lib/workspace-storage";
import type { BrokerKind, ConnectionSummary } from "@/types";

/**
 * 侧栏：一列到底。
 *
 * ```
 * 连接                                     ← 标题 + 新建
 *  ▾ KAFKA  2
 *    │ kafka-prod   10.0.1.12:9092         ← 当前连接（左侧身份色竖线加深）
 *    │     概览 / 集群 / 主题 / 消费组 …    ← 只展开这一条的页面
 *    │ kafka-test   10.0.1.30:9092
 *  ▸ RABBITMQ  3
 * ```
 *
 * 三处刻意的结构：
 *
 * 1. **一列而不是两列**。以前是「连接列表 224 + 菜单 144」并排，一条
 *    `kafka-prod · 10.0.1.12:9092` 的 232px 里有 144px 被另一份菜单占着。
 *    现在 232px 装下全部导航，内容区多出 144px —— 那正好是表格里「滞后量」
 *    和「消费者数」两列的宽度。
 * 2. **连接不做顶部 Tab**。Tab 适合「几个字、数量少、地位平行」；连接带着
 *    名字和端点，五条就排不下。这里用「中间件 → 连接 → 页面」的树，
 *    只有当前连接展开它的页面菜单 —— 五条连接各摊 13 项等于 65 项。
 * 3. **身份色只出现在连接左侧那条竖线上**。Kafka / RabbitMQ 的徽标会跟
 *    「选中态」（靛蓝）抢注意力，两个颜色压在同一个行高里，看不出哪个是
 *    「我现在在哪」。竖线是背景，选中态是前景。
 */
export function Sidebar() {
  const { connectionId } = useParams();
  const { data, isLoading } = useConnections();
  const closeConnection = useCloseConnection();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readCollapsedGroups()));

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 折叠状态跨启动保留：只连 Kafka 的人不该每次开 App 都看见一个空的
  // RabbitMQ 标题，也不该每次都要重新折起同一条连接的页面菜单。
  useEffect(() => {
    saveCollapsedGroups([...collapsed]);
  }, [collapsed]);

  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-10 shrink-0 items-center justify-between px-3.5 pt-1">
        <p className="text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase">
          连接
        </p>
        <NavLink
          to="/?new=1"
          title="新建连接"
          aria-label="新建连接"
          className="flex size-6 items-center justify-center rounded-md text-meta transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <IconServer size={12} />
        </NavLink>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
        {isLoading ? (
          <p className="px-2 text-(length:--text-app-meta) text-meta">加载中…</p>
        ) : null}
        {data?.length === 0 ? (
          <p className="px-2 text-(length:--text-app-meta) leading-relaxed text-meta">
            还没有连接。点上面的 <IconServer size={11} className="inline align-[-1px]" /> 新建一条。
          </p>
        ) : null}

        {groupConnectionsByKind(data ?? []).map((group) => {
          const groupKey = `kind:${group.kind}`;
          const open = !collapsed.has(groupKey);
          return (
            <section key={group.kind} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(groupKey)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase transition-colors hover:text-slate-900"
              >
                {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                <BrokerMark kind={group.kind} size={12} className="text-meta" />
                <span className="flex-1 text-left">
                  {BROKER_LABEL[group.kind as keyof typeof BROKER_LABEL] ?? group.kind}
                </span>
                <span className="tabular text-meta">{group.items.length}</span>
              </button>
              {open
                ? group.items.map((connection) => (
                    <ConnectionNode
                      key={connection.id}
                      connection={connection}
                      active={connectionId === connection.id}
                      pagesOpen={!collapsed.has(`pages:${connection.id}`)}
                      onTogglePages={() => toggle(`pages:${connection.id}`)}
                      onDisconnect={() => closeConnection.mutate(connection.id)}
                      disconnecting={closeConnection.isPending}
                    />
                  ))
                : null}
            </section>
          );
        })}
      </nav>
    </aside>
  );
}

function ConnectionNode({
  connection,
  active,
  pagesOpen,
  onTogglePages,
  onDisconnect,
  disconnecting,
}: {
  connection: ConnectionSummary;
  active: boolean;
  pagesOpen: boolean;
  onTogglePages: () => void;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  return (
    <div className="relative">
      <div
        className={cn(
          "group/row relative ml-1 flex items-center rounded-lg pr-1 transition-colors",
          active ? "bg-indigo-50/80" : "hover:bg-slate-50",
        )}
      >
        <NavLink
          to={connectionPath(connection.id)}
          title={`${connection.name} · ${connection.endpoint}`}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-2"
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

        {/* 两个动作都在悬停 / 键盘聚焦时出现：一个是「这条连接下有哪些页」，
            一个是「收场」。常亮的话，它们会和「切过去」抢同一层的注意力。 */}
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <button
            type="button"
            onClick={onTogglePages}
            aria-expanded={pagesOpen}
            aria-label={pagesOpen ? "收起页面菜单" : "展开页面菜单"}
            title={pagesOpen ? "收起页面菜单" : "展开页面菜单"}
            className="flex size-5.5 items-center justify-center rounded text-meta transition-colors hover:bg-slate-200/70 hover:text-slate-900"
          >
            {pagesOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
          </button>
          <button
            type="button"
            onClick={onDisconnect}
            disabled={disconnecting}
            aria-label={disconnectLabel(connection.name, disconnecting)}
            title={disconnectLabel(connection.name, disconnecting)}
            className="flex size-5.5 items-center justify-center rounded text-meta transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
          >
            <IconClose size={11} />
          </button>
        </div>
      </div>

      {active && pagesOpen ? <ConnectionPages connectionId={connection.id} kind={connection.kind} /> : null}
    </div>
  );
}

/**
 * 当前连接的页面菜单。
 *
 * 分组保留（消息 / 观测 / 配置）：13 项平铺一列，「队列」和「策略」长得
 * 一模一样，其实一个是天天点、一个是改一次就不碰。
 */
function ConnectionPages({ connectionId, kind }: { connectionId: string; kind: BrokerKind }) {
  const location = useLocation();
  const capabilities = useCapabilities(kind);
  const items = buildNavItems(capabilities);

  return (
    <ul className="mt-0.5 mb-1 ml-1.5 flex flex-col border-l border-slate-200 pl-2">
      {groupNavItems(items).map((section) => (
        <li key={section.group}>
          {section.items.length > 1 ? (
            <p className="px-2 pt-1.5 pb-0.5 text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase">
              {NAV_GROUP_LABEL[section.group]}
            </p>
          ) : null}
          <ul className="flex flex-col">
            {section.items.map((item) => (
              <li key={item.capability}>
                <PageLink item={item} connectionId={connectionId} pathname={location.pathname} />
              </li>
            ))}
          </ul>
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
 * 中间件类型图标。分组标题用它来回答「这一组是什么中间件」——
 * 那个位置原来只有一个大写英文单词，图标和字是同一个答案的两种说法。
 */
function BrokerMark({
  kind,
  size = 12,
  className,
}: {
  kind: string;
  size?: number;
  className?: string;
}) {
  const Icon = brokerIcon(kind);
  if (!Icon) return null;
  return <Icon size={size} className={className} />;
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
    </span>
  );
}
