/** 与 `src-tauri/src/domain/runtime.rs` 一一对应的领域类型。 */

export interface ConnectionRow {
  name: string;
  /** 客户端上报的连接名；排查时比服务端生成的 name 有用。 */
  clientName: string;
  user: string;
  peerHost: string;
  peerPort: number;
  channels: number;
  /** running / blocking / blocked 等，服务端原样上报。 */
  state: string;
  recvRate: number;
  sendRate: number;
}

export interface ChannelRow {
  name: string;
  /** 所属连接的 name。 */
  connection: string;
  user: string;
  consumers: number;
  /** 预取上限，0 表示不限。 */
  prefetch: number;
  unacked: number;
  acks: number;
}

export interface ConnectionDetail {
  connection: ConnectionRow;
  channels: ChannelRow[];
  unackedTotal: number;
  /** 预取已打满的 channel 数。 */
  saturated: number;
}

export interface QueuePlacement {
  name: string;
  vhost: string;
  /** 承载该队列的节点；仲裁队列会列出全部成员。空数组 = 当前不可用。 */
  nodes: string[];
  /** classic / quorum / stream。 */
  kind: string;
  durable: boolean;
  exclusive: boolean;
}

export interface RuntimeSnapshot {
  connections: ConnectionDetail[];
  queues: QueuePlacement[];
  /** 没有分配节点的队列名：这些队列当前不可用。 */
  unassigned: string[];
  /** 每个节点承载的队列数。 */
  perNode: Record<string, number>;
}
