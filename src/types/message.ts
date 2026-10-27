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

export interface SendRequest {
  connectionId: string;
  /** Kafka 为 topic，RabbitMQ 为 routing key。 */
  target: string;
  key?: string;
  payload: string;
  headers: MessageHeader[];
  /** RabbitMQ 交换机；Kafka 忽略。 */
  exchange?: string;
}

export interface SendOutcome {
  kind: string;
  detail: string;
}
