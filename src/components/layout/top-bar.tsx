import { NavLink } from "react-router";

import { useConnections } from "@/hooks/use-connections";
import { usePreferences } from "@/hooks/use-preferences";
import { cn } from "@/lib/cn";
import { isMacPlatform } from "@/lib/command-palette";
import { IconCollapse, IconExpand, IconPlus, IconSearch, IconSettings } from "@/lib/icons";
import { BROKER_LABEL } from "@/lib/nav";
import type { LayoutMode } from "@/lib/layout";

import { CommandTrigger } from "./command-trigger";

/**
 * 顶部常量栏。
 *
 * 分出这条栏是为了解决左侧堆得太厚的问题：品牌、命令面板入口、新建连接、
 * 收起按钮过去全塞在连接列表顶部，占了 120px 纵向空间，而这三件事
 * 都属于「整个应用」而不属于「连接列表」。
 *
 * 折叠/展开按钮的分档：分组/平铺 ↔ 极简 是一对反操作，同一个位置互换图标。
 * 窗口太窄时这个按钮禁用 —— 点了也不会生效（`resolveLayout` 会强制极简），
 * 让按钮保持可点却不响应，比直接禁用更让人困惑。
 */
export function TopBar({
  layout,
  current,
  narrow,
  onOpenSettings,
}: {
  layout: LayoutMode;
  /** 当前连接，用于在标题位置说明「在看哪台机器」。 */
  current: { name: string; kind: keyof typeof BROKER_LABEL; endpoint: string } | undefined;
  /** 窄屏时布局被强制为极简，切换按钮没有意义。 */
  narrow: boolean;
  /** 打开偏好设置。齿轮放在最右，和「新建连接」分开，避免误点。 */
  onOpenSettings: () => void;
}) {
  const [, updatePreferences] = usePreferences();
  const { data: connections } = useConnections();

  const collapsed = layout === "collapsed";
  const toggle = () => updatePreferences({ layout: collapsed ? "grouped" : "collapsed" });
  // 极简档把连接列表收成了图标条，需要另一个入口把它们放出来。
  const hiddenConnections = collapsed && (connections?.length ?? 0) > 0;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3">
      {/* 品牌块：一个色块 + 名字。比纯文字更像一个应用，也不占宽度。 */}
      <span className="mr-1 flex shrink-0 items-center gap-2 pr-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-indigo-600 text-(length:--text-app-micro) font-bold text-white">
          MQ
        </span>
        <span className="text-sm font-semibold tracking-tight text-slate-900">MQTui</span>
      </span>

      <button
        type="button"
        onClick={toggle}
        disabled={narrow}
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        title={
          narrow ? "窗口过窄，侧边栏已强制收起" : collapsed ? "展开侧边栏" : "收起侧边栏"
        }
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900",
          narrow && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-slate-500",
        )}
      >
        {collapsed ? <IconExpand /> : <IconCollapse />}
      </button>

      <CommandTrigger />

      {current ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="text-meta">/</span>
          <span className="truncate font-medium text-slate-800">{current.name}</span>
          <span className="shrink-0 text-(length:--text-app-meta) text-meta">
            {BROKER_LABEL[current.kind]} · {current.endpoint}
          </span>
        </div>
      ) : (
        <span className="text-xs text-meta">未连接</span>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {hiddenConnections ? (
          // 极简档下连接列表只剩首字母圆点，二十个连接时认不出谁是谁。
          // 这里给一个直达连接页的出口，而不是让用户去猜圆点。
          <NavLink
            to="/"
            title="连接列表"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-(length:--text-app-meta) text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <IconSearch size={12} />
            <span>{connections?.length} 个连接</span>
          </NavLink>
        ) : null}
        <NavLink
          to="/"
          title="新建连接"
          aria-label="新建连接"
          className="flex size-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <IconPlus />
        </NavLink>
        {/* 偏好入口。以前布局只能从顶栏的折叠按钮切、密度完全没有入口 ——
            一个「当前表格密度：紧凑」只有显示、没有修改的地方。 */}
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="偏好设置"
          title={`偏好设置（${isMacPlatform() ? "⌘," : "Ctrl+,"}）`}
          className="flex size-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <IconSettings />
        </button>
      </span>
    </header>
  );
}
