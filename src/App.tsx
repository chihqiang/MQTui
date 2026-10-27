import { useEffect, type ReactNode } from "react";
import { Outlet, RouterProvider } from "react-router";

import { router } from "./router";

/**
 * 应用根组件。
 *
 * Provider 挂在 `main.tsx`，这里只负责挂载路由。
 * 全局浮层（弹窗、toast）由外壳 `AppShell` 承载，不再跨路由层挂载。
 */
export default function App() {
  return <RouterProvider router={router} />;
}

/** 根布局：首帧清理启动占位条，然后交给路由出口。 */
export function RootLayout({ children }: { children?: ReactNode }) {
  // 首帧挂上了：`index.html` 里那条占位进度条只该活到 React 接管为止，
  // 留着它会一直贴在窗口顶上。
  useEffect(() => {
    document.querySelector(".boot-bar")?.remove();
  }, []);

  return children ?? <Outlet />;
}
