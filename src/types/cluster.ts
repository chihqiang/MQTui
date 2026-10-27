/** 与 `src-tauri/src/domain/cluster.rs` / `cluster_view.rs` 一一对应的领域类型。 */

export type NodeRole = "member" | "disc" | "ram" | "controller" | "offline";

export interface ClusterNode {
  name: string;
  role: NodeRole;
  /** 角色文案由后端给出，前端不自拼中文，避免同一角色两处翻译不一致。 */
  roleLabel: string;
  running: boolean;
  endpoint?: string;
  /** RabbitMQ 才有：该节点上的队列数。 */
  queues?: number;
  /** Kafka 才有：该节点作为 leader 的分区数。 */
  leaders?: number;
}

export type AlertSeverity = "warn" | "info";

export interface ClusterAlert {
  severity: AlertSeverity;
  title: string;
  detail: string;
}

export interface ClusterView {
  nodes: ClusterNode[];
  running: number;
  total: number;
  alerts: ClusterAlert[];
}

/** RabbitMQ 节点指标，与 `domain/node_stats.rs` 的 `NodeStat` 对应。 */
export interface NodeStat {
  name: string;
  running: boolean;
  memUsed: number;
  /** 0 表示管理 API 未上报上限，此时占比按「未知」处理，不能当 0%。 */
  memLimit: number;
  diskFree: number;
  diskLimit: number;
  fdUsed: number;
  fdTotal: number;
  socketsUsed: number;
  socketsTotal: number;
  procUsed: number;
  procTotal: number;
  /** 服务端已触发水位告警（会阻塞发布方）。 */
  alarm: boolean;
}

export interface NodeVerdict {
  name: string;
  headline: string;
  detail: string;
  attention: boolean;
}

export interface NodeReport {
  stats: NodeStat[];
  verdicts: NodeVerdict[];
}
