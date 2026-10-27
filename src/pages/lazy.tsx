/**
 * 路由级按需加载。
 *
 * 桌面壳没有浏览器缓存可以借：主包 590 kB 是一个单 chunk，`tauri://` 首帧要等它
 * 全部解析完才能渲染 —— 冷启动那一下白屏，以及第一次点进「交换机」页时的顿，
 * 都来自这里。
 *
 * 拆法跟目录一致：一个功能域一个 chunk。同一域里的页面互相引用（主题详情 ↔ 主题
 * 配置编辑器），拆成两半只会让两边各背一份依赖，所以只在域边界切刀。
 *
 * 页面本身都是 `export function XxxPage`，这里统一包一层 `lazy`，
 * 路由表照旧从 `@/pages` 取，引用方一行都不用改。
 */

import { lazyNamed } from "@/components/layout/lazy-page";

/** 按功能域拆包；键是域的说明，值是这一域里所有页面的加载器。 */
const connection = {
  ConnectPage: lazyNamed(() => import("./connection/connect-page"), "ConnectPage"),
  WorkspacePage: lazyNamed(() => import("./connection/workspace-page"), "WorkspacePage"),
};

/** 跨中间件的页面：概览、集群、生产、404 都是轻页面，但共用同一批图表原语。 */
const common = {
  OverviewPage: lazyNamed(() => import("./overview-page"), "OverviewPage"),
  ClusterPage: lazyNamed(() => import("./cluster-page"), "ClusterPage"),
  ProducePage: lazyNamed(() => import("./produce-page"), "ProducePage"),
  NotFoundPage: lazyNamed(() => import("./not-found-page"), "NotFoundPage"),
};

const kafka = {
  TopicsPage: lazyNamed(() => import("./kafka/topics-page"), "TopicsPage"),
  TopicDetailPage: lazyNamed(() => import("./kafka/topic-detail"), "TopicDetailPage"),
  ConsumerGroupsPage: lazyNamed(() => import("./kafka/consumer-groups-page"), "ConsumerGroupsPage"),
  OffsetResetPage: lazyNamed(() => import("./kafka/offset-reset-page"), "OffsetResetPage"),
  OrphanTopicsPage: lazyNamed(() => import("./kafka/orphan-topics-page"), "OrphanTopicsPage"),
};

const rabbitmq = {
  RuntimePage: lazyNamed(() => import("./rabbitmq/runtime-page"), "RuntimePage"),
  ConsumersPage: lazyNamed(() => import("./rabbitmq/consumers-page"), "ConsumersPage"),
  ConsumerGraphPage: lazyNamed(() => import("./rabbitmq/consumer-graph-page"), "ConsumerGraphPage"),
  ExchangesPage: lazyNamed(() => import("./rabbitmq/exchanges-page"), "ExchangesPage"),
  RoutingPage: lazyNamed(() => import("./rabbitmq/routing-page"), "RoutingPage"),
  TopologyPage: lazyNamed(() => import("./rabbitmq/topology-page"), "TopologyPage"),
  QueuesPage: lazyNamed(() => import("./rabbitmq/queues-page"), "QueuesPage"),
  ParametersPage: lazyNamed(() => import("./rabbitmq/parameters-page"), "ParametersPage"),
  PoliciesPage: lazyNamed(() => import("./rabbitmq/policies-page"), "PoliciesPage"),
};

const messages = {
  MessagesPage: lazyNamed(() => import("./messages/messages-page"), "MessagesPage"),
};

export const {
  ConnectPage,
  WorkspacePage,
  OverviewPage,
  ClusterPage,
  ProducePage,
  NotFoundPage,
  TopicsPage,
  TopicDetailPage,
  ConsumerGroupsPage,
  OffsetResetPage,
  OrphanTopicsPage,
  RuntimePage,
  ConsumersPage,
  ConsumerGraphPage,
  ExchangesPage,
  RoutingPage,
  TopologyPage,
  QueuesPage,
  ParametersPage,
  PoliciesPage,
  MessagesPage,
} = { ...connection, ...common, ...kafka, ...rabbitmq, ...messages };
