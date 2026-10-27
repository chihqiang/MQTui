import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import "./index.css";

/**
 * React Query 全局配置。
 *
 * 面板数据以“读一次、手动刷新”为主，因此关闭窗口聚焦自动刷新，
 * 避免用户切回窗口时列表跳动。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

/**
 * `StrictMode` 只在开发构建里打开。
 *
 * 它会把每个组件渲染两遍、把 `useEffect` 卸了再装一遍，用来提前暴露副作用不纯的问题 ——
 * 这在开发期是好事，但它同时让开发下的每一次点击都变成两次渲染。面板里的列表动辄
 * 几千行，开着 StrictMode 去 `npm run tauri dev` 里试手感，得到的「卡」有一半是假的。
 *
 * 生产构建里 `StrictMode` 本来就是空操作，所以这里直接按环境切开：
 * 需要排查重复副作用时用 dev server，验收手感时看构建产物。
 */
const app = (
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? <React.StrictMode>{app}</React.StrictMode> : app,
);
