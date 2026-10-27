import type { CSSProperties } from "react";
import { Outlet, useParams } from "react-router";

import { ToastViewport } from "@/components/ui";
import { useConnections } from "@/hooks/use-connections";
import { useViewportWidth } from "@/hooks/use-viewport";
import { NARROW_WIDTH, resolveLayout } from "@/lib/layout";
import { metaFontSize } from "@/lib/visual";

import { ConnectionRail } from "./connection-rail";
import { ConnectionSidebar } from "./connection-sidebar";
import { HealthBar } from "./health-bar";
import { NavSidebar } from "./nav-sidebar";
import { TopBar } from "./top-bar";

/**
 * 应用外壳。
 *
 * ┌──────────────────────────────────────────┐
 * │ 顶部栏：品牌 / 折叠 / 命令 / 当前连接      │
 * ├──────────┬────────┬──────────────────────┤
 * │ 连接列表 │ 菜单    │ 内容区                │
 * └──────────┴────────┴──────────────────────┘
 *
 * 布局分三档（`lib/layout.ts`），由窗口宽度决定，窄屏强制极简：
 * - `grouped`：连接列表 + 分组菜单，13 项菜单按用途分段；
 * - `classic`：连接列表 + 平铺菜单，宽度最小；
 * - `collapsed`：只剩首字母圆点，宽度全给表格。
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

  const narrow = width > 0 && width < NARROW_WIDTH;
  const layout = resolveLayout(width);
  const current = connections?.find((item) => item.id === connectionId);

  return (
    <div
      // `animate-fade-in` 带上 `both` 填充模式：首帧就从透明开始，而不是先闪一帧
      // 不透明再淡入 —— 后者正是「黑一下 / 白一下」观感的来源。
      className="animate-fade-in flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-800 [animation-fill-mode:both]"
      // 次级字号只有一个来源：`--text-app-meta` 原先写死在 `@theme` 里，
      // 组件全用 `text-(length:--text-app-meta)`，所以在这里覆盖一次就全站生效。
      style={{ "--text-app-meta": metaFontSize() } as CSSProperties}
    >
      <TopBar layout={layout} current={current} narrow={narrow} />
      <div className="flex min-h-0 flex-1">
        {layout === "collapsed" ? <ConnectionRail /> : <ConnectionSidebar />}
        {layout === "collapsed" ? null : <NavSidebar grouped={layout === "grouped"} />}
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
          极简档下没有菜单列，顶部栏的「⌘K」入口因此成了唯一的键盘出口，
          位置比过去更靠前。 */}
      <ToastViewport />
    </div>
  );
}
