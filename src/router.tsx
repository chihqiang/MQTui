import { createBrowserRouter } from "react-router";

import { AppShell } from "@/components/layout/app-shell";
import {
  ConnectPage,
  ConsumerGroupsPage,
  ExchangesPage,
  MessagesPage,
  NotFoundPage,
  OrphanTopicsPage,
  OverviewPage,
  ProducePage,
  QueuesPage,
  TopicsPage,
  WorkspacePage,
} from "@/pages";

/**
 * 路由表。
 *
 * 结构与布局一致：
 * - `/` 连接选择页（左侧仍显示历史连接）
 * - `/connections/:connectionId/*` 工作区，菜单项对应子路由
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ConnectPage /> },
      {
        path: "connections/:connectionId",
        children: [
          { index: true, element: <WorkspacePage /> },
          { path: "overview", element: <OverviewPage /> },
          { path: "topics", element: <TopicsPage /> },
          { path: "consumer-groups", element: <ConsumerGroupsPage /> },
          { path: "orphan-topics", element: <OrphanTopicsPage /> },
          { path: "queues", element: <QueuesPage /> },
          { path: "exchanges", element: <ExchangesPage /> },
          { path: "messages", element: <MessagesPage /> },
          { path: "produce", element: <ProducePage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
