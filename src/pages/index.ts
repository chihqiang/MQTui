/**
 * 页面统一出口。
 *
 * pages 下按「功能域」分子目录，路由只从这里取页面，不直接引子目录：
 * - `connection/`：连接选择、工作区与保存的连接
 * - `kafka/`：主题、消费组、位点重置、迁移
 * - `rabbitmq/`：队列、交换机、路由、策略、参数、连接运行时
 * - `messages/`：消息浏览与处置
 *
 * 根目录只留跨中间件的页面（概览 / 集群 / 生产 / 404），避免为了「目录整齐」
 * 把 Kafka、RabbitMQ 共用的页面塞进某一侧的目录里。
 *
 * 这里再导出一次 `lazy.tsx` 里的结果：路由拿到的已经是按域拆包的组件，
 * 但引用路径不用变，页面与路由之间仍然只有这一层契约。
 */
export {
  AccessPage,
  AdminPage,
  ClusterPage,
  ConnectPage,
  ConsumerGraphPage,
  ConsumerGroupsPage,
  ConsumersPage,
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
  TopologyPage,
  TopicsPage,
  WorkspacePage,
} from "./lazy";

// 注意：同域内复用的小组件（如 `rabbitmq/consumers-page` 的 `ConsumerBlock`）
// 不从这一层再导出。这里导出一次就会变成静态依赖，那个页面连同它的依赖会被
// 拽回主包，拆包的效果对「消费者」页直接归零。需要的页面按路径直连即可。
