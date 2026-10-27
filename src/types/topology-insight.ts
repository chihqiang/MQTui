/** 与 `src-tauri/src/domain/topology_insight.rs` 一一对应的领域类型。 */

/** 路由估算的把握程度，前端据此决定是否显示提示。 */
export type RouteConfidence = "certain" | "partial" | "implicit";

/** 一条交换机到队列的估算路由。 */
export interface RouteHop {
  exchange: string;
  queue: string;
  routingKey: string;
  /** 是否经过交换机间的间接跳。 */
  viaExchange: boolean;
  /** 同一交换机上同名的 routing key 均分时的占比；其余情况缺省。 */
  share?: number;
}

/** 单个交换机的前往队列的估算。 */
export interface ExchangeRoute {
  /** 空串表示默认交换机。 */
  exchange: string;
  queues: string[];
  confidence: RouteConfidence;
  /** 出站绑定总数（含指向交换机的绑定）。 */
  bindings: number;
  /** 出站指向交换机的绑定条数。 */
  exchangeHops: number;
  hops: RouteHop[];
}

/** 交换机视角的拓扑洞察。 */
export interface TopologyInsight {
  routes: ExchangeRoute[];
  /** 没有任何出站绑定：收到消息一律静默丢弃。 */
  deadEnds: string[];
  /** 出站指向交换机、但链路最终没落到任何队列。 */
  dangling: string[];
  /** 可达但没有消费者且仍有堆积的队列。 */
  stalled: string[];
}

/** 把握程度的展示文案。 */
export const ROUTE_CONFIDENCE_LABEL: Record<RouteConfidence, string> = {
  certain: "确定",
  partial: "估算",
  implicit: "隐式",
};
