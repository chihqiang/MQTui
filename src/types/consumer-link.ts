/** 与 `src-tauri/src/domain/consumer_link.rs` 一一对应的领域类型。 */

/** 消费者健康状态：只看「看起来活着、实际不干活」这一种情况。 */
export type ConsumerHealth = "healthy" | "unboundedPrefetch" | "prefetchSaturated";

/** 队列上的一个消费者（一个 channel 上的一条 basic.consume）。 */
export interface QueueConsumer {
  queue: string;
  /** 服务端分配的 consumer tag，通常是 `amq.ctag-xxx`，人工排查时没信息量。 */
  consumerTag: string;
  /** 连接名，一般等同 hostname。 */
  connectionName?: string;
  /** 所属 channel。 */
  channel?: string;
  username: string;
  /** 是否手动 ack；`false` 表示自动确认，消息投出去就没了。 */
  ackRequired: boolean;
  /** 预取条数；`0` 表示不限制。 */
  prefetchCount: number;
  messagesUnacknowledged: number;
}

/** 单个队列的消费端汇总。 */
export interface QueueConsumption {
  queue: string;
  messagesReady: number;
  messagesUnacknowledged: number;
  consumers: QueueConsumer[];
  /** 异常消费者数量。 */
  unhealthy: number;
}

export interface ConsumerLinks {
  queues: QueueConsumption[];
  unacknowledgedTotal: number;
}

/** 健康状态的说明文案，与后端 `ConsumerHealth::note()` 保持一致。 */
export const CONSUMER_HEALTH_NOTE: Record<ConsumerHealth, string | null> = {
  healthy: null,
  unboundedPrefetch: "未设置预取上限，可能把整队列消息一次性拉到本地，其它消费者分不到",
  prefetchSaturated: "未确认消息已达到预取上限，该消费者已不再接收新消息",
};

/** 断开判定（与 `domain/consumer_disconnect.rs` 的 `DisconnectVerdict` 对应）。 */
export type DisconnectVerdict =
  | "allowed"
  | "unknownTarget"
  | "ownedByPanel"
  | "inFlight";

/** 断开请求。`confirm` 必须与队列名完全一致。 */
export interface DisconnectRequest {
  connectionId: string;
  queue: string;
  consumerTag: string;
  confirm: string;
}

/** 消费者表的列。 */
export const CONSUMER_COLUMNS = [
  { key: "connection", label: "连接" },
  { key: "user", label: "账号", width: "w-24" },
  { key: "ack", label: "ack", width: "w-16" },
  { key: "prefetch", label: "预取", width: "w-20", align: "right" },
  { key: "unacked", label: "未确认", width: "w-20", align: "right" },
  { key: "state", label: "状态", width: "w-24" },
  { key: "actions", label: "操作", width: "w-16", align: "right" },
] as const;
