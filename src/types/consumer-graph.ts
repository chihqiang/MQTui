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

/**
 * 节点配色：类型决定色系，连接的健康状态决定边框警示。
 *
 * 放在 types 而不是页面里，是因为 `lib/consumer-graph.ts` 与页面都需要它，
 * 而它是纯粹的「类型 → 颜色」映射，没有任何逻辑。
 */
export const LINK_NODE_TONE: Record<string, string> = {
  exchange: "border-sky-300 bg-sky-50 hover:border-sky-500",
  queue: "border-emerald-300 bg-emerald-50 hover:border-emerald-500",
  "connection:warn": "border-amber-400 bg-amber-50 hover:border-amber-500",
  "connection:idle": "border-slate-300 bg-white hover:border-slate-400",
  connection: "border-violet-300 bg-violet-50 hover:border-violet-500",
};

/** 节点类型的中文名，明细区用。 */
export const LINK_KIND_LABEL: Record<LinkNodeKind, string> = {
  exchange: "交换机",
  queue: "队列",
  connection: "消费者连接",
};
