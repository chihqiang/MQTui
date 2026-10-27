/**
 * React Query 的 key 工厂：集中管理避免手写字符串造成缓存错乱。
 */

export const queryKeys = {
  pluginKinds: () => ["plugin-kinds"] as const,
  connections: () => ["connections"] as const,
  overview: (id: string) => ["connections", id, "overview"] as const,
  topics: (id: string) => ["connections", id, "topics"] as const,
  queues: (id: string) => ["connections", id, "queues"] as const,
  /** 所有连接相关查询的共同前缀，写操作后统一失效最省心。 */
  allConnections: () => ["connections"] as const,
  messages: (id: string, target: string) => ["connections", id, "messages", target] as const,
  message: (id: string, messageId: string) =>
    ["connections", id, "message", messageId] as const,
  topology: (id: string) => ["connections", id, "topology"] as const,
  health: (id: string) => ["connections", id, "health"] as const,
  queue: (id: string, queue: string) => ["connections", id, "queue", queue] as const,
  orphanCandidates: (id: string) => ["connections", id, "orphan-candidates"] as const,
  orphanTopics: (id: string, scopeKey: string) =>
    ["connections", id, "orphan-topics", scopeKey] as const,
  consumerGroups: (id: string, keyword: string) =>
    ["connections", id, "consumer-groups", keyword] as const,
  consumerGroup: (id: string, group: string) =>
    ["connections", id, "consumer-group", group] as const,
};
