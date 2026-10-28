/** 与 `src-tauri/src/domain/consumer_ownership.rs` 一一对应的领域类型。 */

import type { ConsumerHealth } from "./consumer-link.ts";

/** 一个消费者在「连接 → channel → 队列」这条链路上的完整位置。 */
export interface ConsumerOwner {
  queue: string;
  consumerTag: string;
  /** 服务端连接名。读不到时缺席 —— 编一个会让人去查一条不存在的连接。 */
  connection?: string;
  /** 客户端上报的连接名，排查时比服务端名字有用。 */
  clientName?: string;
  channel?: string;
  username: string;
  prefetchCount: number;
  messagesUnacknowledged: number;
  ackRequired: boolean;
  health: ConsumerHealth;
  /** 对端地址，形如 `10.0.0.1:52312`。 */
  peer?: string;
  /** 连接已经阻塞或正在关闭：消费者还挂着，消息却不会被投递。 */
  connectionBlocked: boolean;
}

/** 一个队列上的归属汇总。 */
export interface QueueOwnership {
  queue: string;
  messagesReady: number;
  messagesUnacknowledged: number;
  owners: ConsumerOwner[];
  /** 涉及几条不同的连接 —— 这才是「有几个消费者」真正想问的数字。 */
  connections: number;
  users: number;
  /** 预取塞满或连接阻塞的条数。 */
  troubled: number;
}

/** 一个账号被谁在用。 */
export interface UserOwnership {
  username: string;
  connections: number;
  consumers: number;
  queues: string[];
  messagesReady: number;
}

/** 整份归属快照。 */
export interface OwnershipSnapshot {
  queues: QueueOwnership[];
  users: UserOwnership[];
  blockedConsumers: number;
  notes: string[];
}
