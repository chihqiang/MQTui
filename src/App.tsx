import { RouterProvider } from "react-router";

import { router } from "./router";

/**
 * 应用根组件。
 *
 * Provider 挂在 `main.tsx`，这里只负责挂载路由，保持职责单一。
 */
export default function App() {
  return <RouterProvider router={router} />;
}
