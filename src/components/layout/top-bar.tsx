import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router";

import { useCloseConnection, useConnections } from "@/hooks/use-connections";
import { cn } from "@/lib/cn";
import { IconChevronDown, IconClose, IconPlus } from "@/lib/icons";
import { BROKER_LABEL, connectionPath } from "@/lib/nav";
import { disconnectLabel } from "@/lib/reconnect";

import { CommandTrigger } from "./command-trigger";

/**
 * 顶部栏。
 *
 * 只放「整个应用」的东西：品牌、命令面板、当前连接、新建。
 * 连接列表、页面菜单属于导航，在侧栏里，不在这儿。
 *
 * 当前连接做成了一个真的切换器：点名字展开连接清单，一条一条换过去。
 * 图标条形态下侧栏只剩页面图标，这里是切换连接的唯一入口 —— 它不是
 * 「多给一个快捷方式」，而是那个形态下唯一说得通的入口。
 *
 * 断开按钮挨着名字，因为它是这条连接的「收场」：位置必须和「我正在连这个」
 * 这句话连在一起。断开后回连接页 —— 停在原页会立刻收到一堆「连接不存在」。
 */
export function TopBar({
  current,
}: {
  /** 当前连接，用于在标题位置说明「在看哪台机器」。 */
  current: { id: string; name: string; kind: keyof typeof BROKER_LABEL; endpoint: string } | undefined;
}) {
  const { data: connections } = useConnections();
  const closeConnection = useCloseConnection();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const switcher = useRef<HTMLDivElement>(null);

  // 点外面 / 按 Esc 关掉。原生 `popover` 也能做到，但它要求元素在顶层，
  // 而这里需要贴着按钮定位 —— 手写这二十行比把顶栏改成 popover 更划算。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!switcher.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const others = (connections ?? []).filter((item) => item.id !== current?.id);

  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-4">
      {/* 品牌块：一个色块 + 名字。比纯文字更像一个应用，也不占宽度。 */}
      <span className="flex shrink-0 items-center gap-2 pr-1">
        <span className="flex size-8 items-center justify-center rounded-lg bg-indigo-600 text-(length:--text-app-body) font-bold text-white shadow-xs">
          MQ
        </span>
        <span className="text-(length:--text-app-title) font-semibold tracking-tight text-slate-900">
          MQTui
        </span>
      </span>

      {/* 布局档位跟着窗口宽度走，不是一个开关。以前这里画着一个「收起侧栏」
          的图标，点它什么都不会发生（`resolveLayout` 只看宽度）—— 一个
          点了没反应的按钮比没有这个按钮更让人困惑，所以直接去掉。 */}
      <span className="mx-1 h-5 w-px shrink-0 bg-slate-200" aria-hidden />

      <CommandTrigger />

      {/* 中段留白：两个按钮组之间没有间距时，整条栏看着像没排完。 */}
      <span className="flex-1" />

      <div ref={switcher} className="relative flex min-w-0 shrink-0 items-center gap-1">
        {current ? (
          <>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-haspopup="menu"
              title={`${current.name} · ${current.endpoint}`}
              className={cn(
                "flex h-8 max-w-80 min-w-0 items-center gap-2 rounded-lg px-2 text-(length:--text-app-body) transition-colors",
                open ? "bg-slate-100" : "hover:bg-slate-100",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  current.kind === "kafka" ? "bg-broker-kafka" : "bg-broker-rabbitmq",
                )}
              />
              <span className="truncate font-medium text-slate-800">{current.name}</span>
              <span className="hidden min-w-0 truncate font-mono text-(length:--text-app-meta) text-meta lg:inline">
                {current.endpoint}
              </span>
              <IconChevronDown size={12} className="shrink-0 text-meta" />
            </button>
            <button
              type="button"
              onClick={() => closeConnection.mutate(current.id)}
              disabled={closeConnection.isPending}
              aria-label={disconnectLabel(current.name, closeConnection.isPending)}
              title={disconnectLabel(current.name, closeConnection.isPending)}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-meta transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
            >
              <IconClose size={12} />
            </button>
          </>
        ) : (
          <span className="text-(length:--text-app-body) text-meta">未连接</span>
        )}

        {open ? (
          <div
            role="menu"
            className="animate-pop-in absolute top-full right-0 z-20 mt-1 w-72 overflow-hidden rounded-xl bg-white p-1 shadow-lg ring-1 ring-slate-200"
          >
            <p className="px-2 py-1.5 text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase">
              切换连接
            </p>
            {others.length === 0 ? (
              <p className="px-2 py-2 text-(length:--text-app-meta) text-meta">
                只有这一条连接。到连接页可以再建一条。
              </p>
            ) : (
              others.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    navigate(connectionPath(connection.id));
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-slate-50"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      connection.kind === "kafka" ? "bg-broker-kafka" : "bg-broker-rabbitmq",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-(length:--text-app-body) text-slate-800">
                      {connection.name}
                    </span>
                    <span className="block truncate font-mono text-(length:--text-app-meta) text-meta">
                      {connection.endpoint}
                    </span>
                  </span>
                  <span className="shrink-0 text-(length:--text-app-meta) text-meta">
                    {BROKER_LABEL[connection.kind]}
                  </span>
                </button>
              ))
            )}
            <div className="mt-1 border-t border-slate-100 pt-1">
              <NavLink
                to="/"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-(length:--text-app-body) text-slate-700 transition-colors hover:bg-slate-50"
              >
                全部连接（{connections?.length ?? 0}）
              </NavLink>
            </div>
          </div>
        ) : null}
      </div>

      {/* 新建连接：进首页并用 `?new=1` 唤起向导。顶栏没有前置选择，所以它是
          唯一一个真的会问「连哪种」的入口；首页的卡片带着类型，点进去直接
          就是参数表单。 */}
      <NavLink
        to="/?new=1"
        title="新建连接"
        aria-label="新建连接"
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
      >
        <IconPlus />
      </NavLink>
    </header>
  );
}
