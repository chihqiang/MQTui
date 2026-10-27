import { Suspense, lazy, type ComponentType } from "react";
import { Outlet, createBrowserRouter } from "react-router";

import { RootLayout } from "@/App";
import { AppShell } from "@/components/layout/app-shell";
import { PageLoading } from "@/components/ui";
import {
  AccessPage,
  AdminPage,
  ClusterPage,
  ConsumerGraphPage,
  ConsumersPage,
  ConsumerGroupsPage,
  ExchangesPage,
  MessagesPage,
  NotFoundPage,
  OffsetResetPage,
  OrphanTopicsPage,
  OverviewPage,
  ParametersPage,
  PoliciesPage,
  ProducePage,
  QueuesPage,
  RoutingPage,
  RuntimePage,
  TopicDetailPage,
  TopicsPage,
  TopologyPage,
  WorkspacePage,
} from "@/pages";

/**
 * 首页（选中间件 + 连接记录）也拆包，但**同步预载**。
 *
 * 只把它写进 `lazy` 的话，首帧会先画外壳、再等一个 chunk，中间空一帧；
 * 干脆放进主包又会让每次改首页都动到主 chunk。折中：`lazy` 保留分包，
 * 但模块一被解析就用同一个 import 把 chunk 预热掉 —— 等路由真要渲染它时，
 * promise 已经 resolve，`Suspense` 的 fallback 一次都不会出现。
 */
const loadConnectPage = () => import("./pages/connection/connect-page");
const ConnectPage = lazy(async () => {
  const module = await loadConnectPage();
  return { default: module.ConnectPage as ComponentType };
});
// 冷启动预热：不 await，失败也无关紧要（真的失败时路由会再 import 一次并报错）。
void loadConnectPage();

/**
 * 路由表。
 *
 * 结构与布局一致：
 * - `/` 连接选择页（左侧仍显示历史连接）
 * - `/connections/:connectionId/*` 工作区，菜单项对应子路由
 *
 * 页面按功能域拆包（见 `pages/lazy.tsx`），首屏只加载连接页那一份。
 *
 * 边界只包一圈 `Suspense`，且包在 `AppShell` 之内：
 * 外壳（连接列表 / 菜单 / 健康条）常驻，切页面时只有内容区换成加载态 ——
 * 整屏闪一下白比多等 30ms 更像「软件卡了」。
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <RootLayout>
        <AppShell />
      </RootLayout>
    ),
    children: [
      {
        element: (
          <Suspense fallback={<PageLoading />}>
            <ContentOutlet />
          </Suspense>
        ),
        children: [
          { index: true, element: <ConnectPage /> },
          {
            path: "connections/:connectionId",
            children: [
              { index: true, element: <WorkspacePage /> },
              { path: "overview", element: <OverviewPage /> },
              { path: "cluster", element: <ClusterPage /> },
              { path: "runtime", element: <RuntimePage /> },
              { path: "topics", element: <TopicsPage /> },
              { path: "topics/:topicName", element: <TopicDetailPage /> },
              { path: "consumer-groups", element: <ConsumerGroupsPage /> },
              { path: "offset-reset", element: <OffsetResetPage /> },
              { path: "orphan-topics", element: <OrphanTopicsPage /> },
              { path: "access", element: <AccessPage /> },
              { path: "queues", element: <QueuesPage /> },
              { path: "policies", element: <PoliciesPage /> },
              { path: "admin", element: <AdminPage /> },
              { path: "parameters", element: <ParametersPage /> },
              { path: "exchanges", element: <ExchangesPage /> },
              { path: "consumers", element: <ConsumersPage /> },
              { path: "routing", element: <RoutingPage /> },
              { path: "topology", element: <TopologyPage /> },
              { path: "consumer-graph", element: <ConsumerGraphPage /> },
              { path: "messages", element: <MessagesPage /> },
              { path: "produce", element: <ProducePage /> },
              { path: "*", element: <NotFoundPage /> },
            ],
          },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

/** 再导出一层 `Outlet`：`Suspense` 必须包在真正渲染子路由的组件外层，而不是并排。 */
function ContentOutlet() {
  return <Outlet />;
}
