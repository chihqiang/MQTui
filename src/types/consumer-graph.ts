/** 与 `src-tauri/src/domain/consumer_graph.rs` 一一对应的领域类型。 */

export type LinkNodeKind = "exchange" | "queue" | "connection";
export type LinkEdgeKind = "binding" | "consume";

/** 连接侧健康状态。`warn` 是「有消费者卡在预取上限」，`idle` 是「一个消息都没领到」。 */
export type LinkHealth = "healthy" | "warn" | "idle";

export interface LinkNode {
  /** 形如 `e:orders` / `q:orders` / `c:svc-a`。 */
  id: string;
  kind: LinkNodeKind;
  name: string;
  subtitle?: string;
  layer: number;
  row: number;
  health?: LinkHealth;
}

export interface LinkEdge {
  from: string;
  to: string;
  kind: LinkEdgeKind;
  /** 绑定边的 routing key；消费边是空串。 */
  label: string;
}

export interface ConsumerGraph {
  nodes: LinkNode[];
  edges: LinkEdge[];
  layers: number;
  omitted: number;
  queueCount: number;
  connectionCount: number;
}

export const NODE_PREFIX = {
  exchange: "e:",
  queue: "q:",
  connection: "c:",
} as const;

/** 节点标识里取类型前缀，用来决定颜色与图标。 */
export function kindOf(nodeId: string): LinkNodeKind {
  if (nodeId.startsWith(NODE_PREFIX.exchange)) return "exchange";
  if (nodeId.startsWith(NODE_PREFIX.connection)) return "connection";
  return "queue";
}
