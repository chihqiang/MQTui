/** 与 `src-tauri/src/domain/message.rs` 一一对应的领域类型。 */

export interface MessageHeader {
  key: string;
  value: string;
}

export interface MessageQuery {
  connectionId: string;
  /** Kafka 为 topic，RabbitMQ 为 queue。 */
  target: string;
  limit?: number;
  /** 上一页返回的游标，原样回传表示「加载更多」；缺省表示从头读。 */
  cursor?: string;
  /**
   * 只看某个分区（仅 Kafka）。
   *
   * 它只决定**首次读取**挑哪些分区；带游标续读时由游标决定进度，
   * 所以「加载更多」不需要重复传。
   */
  partition?: number;
}

export interface MessageSummary {
  id: string;
  key?: string;
  topic?: string;
  partition?: number;
  offset?: number;
  timestamp?: number;
  preview: string;
  size?: number;
  /** 完整 payload，仅 RabbitMQ 列表带（AMQP 无法按 deliveryTag 事后回源）。 */
  payload?: string;
}

export interface MessageDetail {
  summary: MessageSummary;
  payload: string;
  payloadBase64?: string;
  headers: MessageHeader[];
}

export interface MessagePage {
  items: MessageSummary[];
  /** 是否还有更多数据可读。 */
  hasMore: boolean;
  /** 下一页游标。 */
  cursor?: string;
  source: string;
}

/** 定位条件：Kafka 日志里按 key / 时间区间找消息。 */
export interface MessageLocate {
  connectionId: string;
  target: string;
  /** 精确匹配的 key；空串视为不按 key 过滤。 */
  key?: string;
  /**
   * 内容片段，包含匹配、不区分大小写。
   * 必须与时间区间一起用：内容匹配要逐条解码消息体，没有区间就是全量扫日志。
   */
  content?: string;
  /** 时间区间起点（毫秒，含）。 */
  after?: number;
  /** 时间区间终点（毫秒，含）。 */
  before?: number;
  limit?: number;
  /** 上一页返回的续扫游标，原样回传表示「接着上次停下的位置继续」。 */
  cursor?: string;
}

/** 定位结果。 */
export interface MessageSearch {
  items: MessageSummary[];
  /** 实际解码过的条数（含未命中），用于说明这次扫描的代价。 */
  scanned: number;
  /** 是否因扫描上限/时间预算提前结束。 */
  truncated: boolean;
  /** 扫描范围的人话说明。 */
  note: string;
  /** 续扫游标。缺失表示已经扫到日志尽头，没有更多可读。 */
  cursor?: string;
  /** 本次扫描起点说明（首次扫描 / 续扫 N 个分区 / 条件变化后从头扫）。 */
  resumedFrom?: string;
  /** 内容扫描的条数预算说明；只在按内容查找时出现。 */
  contentBudget?: string;
}

/**
 * 发送请求：两种中间件各说各的，不是一张表单。
 *
 * 原来是一个扁平的 `{ target, key, exchange }`，字段按中间件互相忽略 ——
 * `exchange` 在 Kafka 下永远传 undefined，`key` 在 RabbitMQ 下永远是空。
 * 看起来只是多两个字段，实际是把「填了没用」写进了类型里：新加一种中间件时，
 * 没人知道哪些字段是它的。现在按 kind 分叉，缺字段是编译错误，不是运行时静默忽略。
 */
export type SendRequest = KafkaSendRequest | RabbitMqSendRequest;

/** Kafka：投到 topic，`key` 决定分区落点。 */
export interface KafkaSendRequest {
  kind: "kafka";
  connectionId: string;
  /** 目标 topic。 */
  topic: string;
  /** 消息 key；空着则由 partitioner 轮询选分区。 */
  key?: string;
  payload: string;
}

/** RabbitMQ：投到 exchange + routing key，由交换机决定去哪些队列。 */
export interface RabbitMqSendRequest {
  kind: "rabbitMq";
  connectionId: string;
  /** 目标交换机；空串表示默认交换机（按 routing key 直投同名队列）。 */
  exchange: string;
  /** routing key。 */
  routingKey: string;
  payload: string;
  /** 投递模式：持久化消息（`2`）在 broker 重启后仍在，非持久化（`1`）不在。 */
  deliveryMode: number;
  /** 内容类型，例如 `application/json`。缺省 `text/plain`。 */
  contentType?: string;
  /** 内容编码，例如 `gzip`。缺省不带。 */
  contentEncoding?: string;
  headers: MessageHeader[];
}

export interface SendOutcome {
  kind: string;
  detail: string;
}
