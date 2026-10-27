import { Suspense } from "react";
import { Outlet, createBrowserRouter } from "react-router";

import { RootLayout } from "@/App";
import { AppShell } from "@/components/layout/app-shell";
import { PageLoading } from "@/components/ui";
import {
  ClusterPage,
  ConnectPage,
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
 * 路由表。
 *
 * 结构与布局一致：
 * - `/` 连接选择页（左侧仍显示历史连接）
 * - `/connections/:connectionId/*` 工作区，菜单项对应子路由
 *
 * 页面按功能域拆包（见 `pages/lazy.tsx`），首屏只加载连接页那一份。
 * 根路由的 `element` 是 `RootLayout` 而不是 `AppShell`：全局浮层（命令面板）
 * 需要路由上下文才能 `useNavigate()`，又要与导航解耦不随页面卸载，
 * 只有「根路由 + Outlet」同时满足这两条。
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
              { path: "queues", element: <QueuesPage /> },
              { path: "policies", element: <PoliciesPage /> },
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
