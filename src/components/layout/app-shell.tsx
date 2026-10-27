import type { CSSProperties } from "react";
import { Outlet, useParams } from "react-router";

import { ToastViewport } from "@/components/ui";
import { useConnections } from "@/hooks/use-connections";
import { useViewportWidth } from "@/hooks/use-viewport";
import { SIDEBAR_WIDTH, resolveLayout } from "@/lib/layout";
import { metaFontSize } from "@/lib/visual";

import { ConnectionRail } from "./connection-rail";
import { HealthBar } from "./health-bar";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

/**
 * 应用外壳。
 *
 * ┌──────────────────────────────────────────┐
 * │ 顶部栏：品牌 / 命令 / 当前连接 / 新建      │
 * ├──────────┬───────────────────────────────┤
 * │ 侧栏      │ 健康条                        │
 * │ 中间件    │ 页面标题 + 工具条              │
 * │  └ 连接   │ 内容区                        │
 * │      └ 页 │                               │
 * └──────────┴───────────────────────────────┘
 *
 * 布局只有两档（`lib/layout.ts`），由窗口宽度决定：
 * - `sidebar`：一列 232px，中间件 → 连接 → 该连接的页面菜单；
 * - `rail`：只剩图标条，宽度全给表格。
 *
 * 以前是「连接列表 + 菜单」两列并排再加一档「平铺」，三种形态其实只在
 * 解释同一件事：导航放哪。现在导航只有一处，形态也就只剩一档开关。
 *
 * 两处刻意的取舍：
 * - 宽度变化不加过渡，也不在内容区做动画：内容区跟着动画会让表格的横向
 *   滚动位置在每次展开/收起时跳一下；
 * - 健康条只在选中连接时出现，且全绿时只占一条细线 —— 常态下它不该
 *   和页面标题抢同样的注意力。
 */
export function AppShell() {
  const { connectionId } = useParams();
  const { data: connections } = useConnections();
  const width = useViewportWidth();

  const layout = resolveLayout(width);
  const current = connections?.find((item) => item.id === connectionId);

  return (
    <div
      // `animate-fade-in` 带上 `both` 填充模式：首帧就从透明开始，而不是先闪一帧
      // 不透明再淡入 —— 后者正是「黑一下 / 白一下」观感的来源。
      className="animate-fade-in flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-800 [animation-fill-mode:both]"
      // 次级字号只有一个来源：`--text-app-meta` 原先写死在 `@theme` 里，
      // 组件全用 `text-(length:--text-app-meta)`，所以在这里覆盖一次就全站生效。
      style={
        {
          "--text-app-meta": metaFontSize(),
          "--sidebar-width": `${SIDEBAR_WIDTH}px`,
        } as CSSProperties
      }
    >
      <TopBar current={current} />
      <div className="flex min-h-0 flex-1">
        {layout === "rail" ? <ConnectionRail /> : <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 未选中连接时（连接页）没有可探测的对象，不显示健康条。
              判据用路由参数而不是 store：store 是在渲染之后由 `useEffect` 同步的，
              用它做条件会让每次进页面时健康条闪一帧才出现，内容区跟着上移 ——
              切换菜单时整屏跳一下，正是那种说不上来的「不丝滑」。 */}
          {connectionId ? <HealthBar connectionId={connectionId} /> : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
        </main>
      </div>
      {/* 命令面板不在这儿：它挂在路由之外（`App.tsx`），导航时不会被卸载重挂。
          图标条形态下连接切换只剩顶部栏那个入口，「⌘K」因此是键盘用户的
          唯一退路。 */}
      <ToastViewport />
    </div>
  );
}
