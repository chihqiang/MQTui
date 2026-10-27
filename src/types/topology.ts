/** 与 `src-tauri/src/domain/topology.rs` 一一对应的领域类型。 */

export type ExchangeKind = "direct" | "fanout" | "topic" | "headers" | "unknown";

export interface ExchangeInfo {
  name: string;
  vhost: string;
  /** 服务端上报的原始类型字符串，未知类型也能原样展示。 */
  kind: string;
  exchangeType: ExchangeKind;
  /** 内置交换机（`amq.*`），不可删除。 */
  internal: boolean;
  /** 消息进入速率（每秒）。 */
  messageRate: number;
}

export type BindingDestination = "queue" | "exchange";

export interface BindingInfo {
  /** `""` 表示默认交换机。 */
  source: string;
  destination: string;
  destinationType: BindingDestination;
  routingKey: string;
  arguments?: { key: string; value: string }[];
}

export interface RabbitMqTopology {
  exchanges: ExchangeInfo[];
  bindings: BindingInfo[];
  queues: import("./broker").QueueInfo[];
}

/** 新建绑定请求，字段与后端 `BindingSpec` 对应。 */
export interface BindingSpec {
  /** 源交换机；空串表示默认交换机。 */
  source: string;
  destination: { name: string; kind: BindingDestination };
  routingKey: string;
  /** headers 交换机靠参数匹配，其余类型留空。 */
  arguments?: { key: string; value: string }[];
}

/** 删除绑定时的定位信息。 */
export interface BindingKey {
  source: string;
  destination: string;
  destinationType: BindingDestination;
  routingKey: string;
  /** 同名 routing key 的 headers 绑定靠参数区分，删除时必须带上。 */
  arguments?: { key: string; value: string }[];
}

/** 新建交换机请求，字段与后端 `ExchangeSpec` 对应。 */
export interface ExchangeSpec {
  name: string;
  /** direct / fanout / topic / headers。 */
  kind: string;
  durable: boolean;
  autoDelete: boolean;
}

/** 队列详情：列表给「有多少」，详情回答「谁在消费、从哪来」。 */
export interface QueueDetail {
  name: string;
  vhost: string;
  /** running / idle / flow 等，服务端原样上报。 */
  state: string;
  consumers: number;
  messages: number;
  messagesReady: number;
  messagesUnacknowledged: number;
  /** 入队速率（每秒）。 */
  incomingRate: number;
  /** 投递速率（每秒）。 */
  deliverRate: number;
  durable: boolean;
  autoDelete: boolean;
  arguments?: { key: string; value: string }[];
  /** 指向该队列的绑定，回答「消息从哪来」。 */
  bindings?: BindingInfo[];
}
