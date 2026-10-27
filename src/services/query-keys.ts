/**
 * React Query 的 key 工厂：集中管理避免手写字符串造成缓存错乱。
 */

/**
 * 连接级查询的键前缀。
 *
 * 连接列表（`queryKeys.connections()`）与「某个连接的各项数据」共用 `connections`
 * 这个前缀，于是一直有个隐患：任何一次 `invalidateQueries(["connections"])`
 * 都会把**连接列表本身**一起打回加载态 —— 侧边栏闪一下「加载中…」、菜单消失一帧、
 * 命令面板里的连接项跟着重排。表面上什么都没坏，但每次建连 / 关连都付一次。
 *
 * 所以连接级数据多一层 `connection(id)`：要失效整个连接用
 * `queryKeys.connection(id)`，要失效全部连接用 `queryKeys.allConnections()`，
 * 两者都不会碰到连接列表。
 */
export const queryKeys = {
  pluginKinds: () => ["plugin-kinds"] as const,
  connections: () => ["connections"] as const,
  /** 单个连接下所有查询的前缀（不含连接列表本身）。 */
  connection: (id: string) => ["connections", "detail", id] as const,
  overview: (id: string) => ["connections", "detail", id, "overview"] as const,
  topics: (id: string) => ["connections", "detail", id, "topics"] as const,
  queues: (id: string) => ["connections", "detail", id, "queues"] as const,
  /** 策略快照：普通策略 + 操作员策略一次拉全。 */
  policies: (id: string) => ["connections", "detail", id, "policies"] as const,
  /** 账户页快照：vhost 汇总 + 用户 + 权限，一次拉全。 */
  admin: (id: string) => ["connections", "detail", id, "admin"] as const,
  /** 参数快照：联邦 / 铲子 / 运行时三类一次拉全。 */
  parameters: (id: string) => ["connections", "detail", id, "parameters"] as const,
  /** 策略预览：按表单内容缓存，改一个字符就该重算。 */
  policyPreview: (id: string, fingerprint: string) =>
    ["connections", "detail", id, "policy-preview", fingerprint] as const,
  /** 所有连接下所有查询的共同前缀，写操作后统一失效最省心。 */
  allConnections: () => ["connections", "detail"] as const,
  /**
   * 消息分页带上单页条数：分页策略变了就该是另一份缓存，不会读到按旧条数切好的页。
   *
   * `partition` 是可选后缀：不按分区筛时键与原来完全一致，缓存前缀不受影响。
   */
  messages: (id: string, target: string, pageSize: number, partition?: number) =>
    [
      "connections",
      "detail",
      id,
      "messages",
      target,
      pageSize,
      ...(partition === undefined ? [] : [partition]),
    ] as const,
  /** 定位结果按条件缓存：同一条件重复查询不该重扫一遍日志。 */
  messageSearch: (id: string, target: string, conditionKey: string) =>
    ["connections", "detail", id, "message-search", target, conditionKey] as const,
  message: (id: string, messageId: string) =>
    ["connections", "detail", id, "message", messageId] as const,
  topology: (id: string) => ["connections", "detail", id, "topology"] as const,
  topologyInsight: (id: string) => ["connections", "detail", id, "topology-insight"] as const,
  topologyGraph: (id: string) => ["connections", "detail", id, "topology-graph"] as const,
  consumerGraph: (id: string) => ["connections", "detail", id, "consumer-graph"] as const,
  health: (id: string) => ["connections", "detail", id, "health"] as const,
  /** 集群视图：一次元数据 / 一次 /api/nodes，键里不需要再加参数。 */
  cluster: (id: string) => ["connections", "detail", id, "cluster"] as const,
  /** 运行时：连接 + 通道 + 队列位置来自同一份快照，整体缓存。 */
  runtime: (id: string) => ["connections", "detail", id, "runtime"] as const,
  nodeStats: (id: string) => ["connections", "detail", id, "node-stats"] as const,
  /** 位点重置预览：按「组 + 主题 + 目标」缓存，换目标必须重算。 */
  resetPreview: (id: string, group: string, topic: string, target: string) =>
    ["connections", "detail", id, "reset-preview", group, topic, target] as const,
  resetPhases: (id: string, group: string) => ["connections", "detail", id, "reset-phases", group] as const,
  queue: (id: string, queue: string) => ["connections", "detail", id, "queue", queue] as const,
  /** 消费者连线：整连接一次拉全，队列详情里的消费者也从这里取。 */
  queueConsumers: (id: string) => ["connections", "detail", id, "queue-consumers"] as const,
  orphanCandidates: (id: string) => ["connections", "detail", id, "orphan-candidates"] as const,
  orphanTopics: (id: string, scopeKey: string) =>
    ["connections", "detail", id, "orphan-topics", scopeKey] as const,
  consumerGroups: (id: string, keyword: string) =>
    ["connections", "detail", id, "consumer-groups", keyword] as const,
  consumerGroup: (id: string, group: string) =>
    ["connections", "detail", id, "consumer-group", group] as const,
  /** 滞后趋势：换采样间隔就是另一份结果，必须进键。 */
  lagTrend: (id: string, group: string, windowMs: number) =>
    ["connections", "detail", id, "lag-trend", group, windowMs] as const,
  /** 主题详情：分区布局决定「能不能扩容」，因此与列表分开缓存。 */
  topic: (id: string, topic: string) => ["connections", "detail", id, "topic", topic] as const,
  disposalCapabilities: (id: string, messageId: string) =>
    ["connections", "detail", id, "disposal-capabilities", messageId] as const,
  topicCapabilities: (id: string, topic: string) =>
    ["connections", "detail", id, "topic-capabilities", topic] as const,
  /** 分区热点分析：结果取决于选中的主题集合，按集合做 key。 */
  partitionHotspots: (id: string, topicsKey: string) =>
    ["connections", "detail", id, "partition-hotspots", topicsKey] as const,
};
