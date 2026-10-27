/** 与 `src-tauri/src/domain/topology_graph.rs` 一一对应的领域类型。 */

export type GraphNodeKind = "exchange" | "queue";

export interface GraphNode {
  /** 唯一标识，形如 `e:orders` / `q:orders`。同名交换机与队列靠前缀区分。 */
  id: string;
  kind: GraphNodeKind;
  /** 原始名称；空串表示默认交换机。 */
  name: string;
  /** 层级：默认交换机与无上游的交换机为第 0 层。 */
  layer: number;
  /** 层内序号，已按名称排好。 */
  row: number;
  messages?: number;
  consumers?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** routing key；空串表示按队列名直投或 fanout。 */
  routingKey: string;
}

export interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
  /** 被截断的节点数；为 0 表示画的就是全部。 */
  omitted: number;
}

/** 默认交换机名是空串，图上必须显示成一句人话而不是一片空白。 */
export const DEFAULT_EXCHANGE_LABEL = "(默认交换机)";
