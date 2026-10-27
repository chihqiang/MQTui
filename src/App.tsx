import type { ReactNode } from "react";
import { Outlet, RouterProvider } from "react-router";

import { CommandPalette } from "./components/layout/command-palette";

import { router } from "./router";

/**
 * 应用根组件。
 *
 * `CommandPalette` 挂在**路由之外**。它原来挂在外壳 `AppShell` 里，于是每次导航
 * （切菜单、进详情、按一次返回）都会把它连带卸载再挂载：一个 `useEffect`
 * 卸载时解绑全局 keydown、挂载时再绑一次，`matches` / 排序全部重算一遍，
 * 面板里那份「最近使用的命令」也跟着重新读一次 localStorage。
 *
 * 它本来就是全局的（任何页面都能唤出），挂在这里以后路由切换与它无关。
 *
 * 「路由之外」不等于「路由上下文之外」：`RouterProvider` 只对它的**子树**提供
 * context，并排写兄弟节点是拿不到的 —— 面板里 `useNavigate()` / `useParams()`
 * 会直接抛 "useNavigate() may be used only in the context of a <Router> component"，
 * 整棵树渲染失败，窗口一片全黑。所以把它挂成根路由的 `element`：
 * 与导航解耦，同时仍在 `RouterProvider` 里。见 `RootLayout`。
 *
 * Provider 挂在 `main.tsx`，这里只负责挂载路由与全局浮层。
 */
export default function App() {
  return <RouterProvider router={router} />;
}

/**
 * 根布局：全局浮层 + 路由出口。
 *
 * 面板必须渲染在**能拿到路由上下文的子树里**，所以由根路由挂载它，
 * 而不是在 `App` 里和 `RouterProvider` 并排。
 */
export function RootLayout({ children }: { children?: ReactNode }) {
  return (
    <>
      {children ?? <Outlet />}
      <CommandPalette />
    </>
  );
}
