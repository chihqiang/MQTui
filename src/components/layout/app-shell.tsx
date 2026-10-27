import { useEffect, useState, type CSSProperties } from "react";
import { Outlet, useParams } from "react-router";

import { Button, ToastViewport } from "@/components/ui";
import { useConnections } from "@/hooks/use-connections";
import { usePreferences } from "@/hooks/use-preferences";
import { useViewportWidth } from "@/hooks/use-viewport";
import { NARROW_WIDTH, resolveLayout } from "@/lib/layout";
import { metaFontSize } from "@/lib/visual";

import { ConnectionRail } from "./connection-rail";
import { ConnectionSidebar } from "./connection-sidebar";
import { HealthBar } from "./health-bar";
import { NavSidebar } from "./nav-sidebar";
import { SettingsDialog } from "./settings-dialog";
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
 * 布局分三档（`lib/layout.ts`），由用户偏好决定，窄屏强制极简：
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
  const [preferences] = usePreferences();
  const { data: connections } = useConnections();
  const width = useViewportWidth();
  // 设置弹窗的状态留在外壳里而不是全局 store：它没有任何跨页面的语义，
  // 每次导航都关掉反而更顺手。
  const [settingsOpen, setSettingsOpen] = useState(false);

  const narrow = width > 0 && width < NARROW_WIDTH;
  // 窄屏降级是**静默**发生的：菜单列没了、顶栏的切换按钮变灰，用户不知道是谁干的。
  // 这里给一条一次性的提示，点「知道了」就记住，不反复出现。
  const [narrowDismissed, dismissNarrow] = useNarrowDismissed();
  const layout = resolveLayout(preferences.layout, width);
  const current = connections?.find((item) => item.id === connectionId);

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-slate-50 text-slate-800"
      // 次级字号只有一个来源：`--text-app-meta` 原先写死在 `@theme` 里，
      // 组件全用 `text-(length:--text-app-meta)`，所以在这里覆盖一次就全站生效，
      // 不需要每个组件各读一遍偏好。
      style={{ "--text-app-meta": metaFontSize(preferences.metaScale) } as CSSProperties}
    >
      <TopBar
        layout={layout}
        current={current}
        narrow={narrow}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        {layout === "collapsed" ? <ConnectionRail /> : <ConnectionSidebar />}
        {layout === "collapsed" ? null : <NavSidebar grouped={layout === "grouped"} />}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {narrow && !narrowDismissed ? (
            <div
              role="status"
              className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-(length:--text-app-meta) text-amber-800"
            >
              <span className="min-w-0 flex-1">
                窗口窄于 {NARROW_WIDTH}px，侧边栏已收起成图标条。
                <span className="text-amber-600">拉宽窗口后会按你选的布局恢复。</span>
              </span>
              <Button size="xs" variant="ghost" onClick={() => dismissNarrow()}>
                知道了
              </Button>
            </div>
          ) : null}
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
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ToastViewport />
    </div>
  );
}

/**
 * 「窄屏提示已读」。
 *
 * 存在 localStorage 而不是会话内存：同一个人每天开同一个窗口宽度，
 * 每次都提醒一遍就是骚扰。换了更宽的屏之后提示自然不再出现，
 * 所以这条记一辈子也不会误伤。
 */
const NARROW_HINT_KEY = "mqtui.narrow-hint-dismissed";

function useNarrowDismissed(): [boolean, () => void] {
  const [dismissed, setDismissedState] = useState(() => {
    try {
      return window.localStorage.getItem(NARROW_HINT_KEY) === "1";
    } catch {
      return false;
    }
  });

  const dismiss = () => {
    setDismissedState(true);
    try {
      window.localStorage.setItem(NARROW_HINT_KEY, "1");
    } catch {
      // 隐私模式下写不进去：这次会话里仍然按已读处理，不反复弹。
    }
  };

  // 跨窗口同步：打开第二个窗口时不该再提示一遍。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === NARROW_HINT_KEY) setDismissedState(event.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [dismissed, dismiss];
}
