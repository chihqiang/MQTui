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

/** 通道表的列。 */
export const CHANNEL_COLUMNS = [
  { key: "channel", label: "通道" },
  { key: "user", label: "账号", width: "w-24" },
  { key: "consumers", label: "消费者", width: "w-20", align: "right" },
  { key: "prefetch", label: "预取", width: "w-20", align: "right" },
  { key: "unacked", label: "未确认", width: "w-24", align: "right" },
  { key: "acks", label: "已确认", width: "w-24", align: "right" },
  { key: "state", label: "状态", width: "w-24" },
  { key: "actions", label: "操作", width: "w-20", align: "right" },
] as const;

/**
 * 运行时页里选中的目标：一条连接，或它上面的一个通道。
 *
 * 弹窗关的是哪一个，全凭这个结构 —— 只存名字不够，通道名只在连接内唯一。
 */
export type RuntimeTarget =
  | { kind: "connection"; detail: ConnectionDetail; name: string }
  | { kind: "channel"; detail: ConnectionDetail; name: string };
