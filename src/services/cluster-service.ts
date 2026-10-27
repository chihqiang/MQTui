/** 集群与运行时接口，对应 `src-tauri/src/commands/cluster.rs`。 */

import { call } from "./ipc";
import type { ClusterView, NodeReport, QueuePlacement, RuntimeSnapshot } from "@/types";
import type { ConnectionDetail } from "@/types";

export const clusterService = {
  /** 集群视图：节点 + 报警。Kafka 与 RabbitMQ 通用。 */
  loadCluster: (id: string) => call<ClusterView>("load_cluster", { id }),

  /** RabbitMQ 运行时：连接、通道、队列位置。 */
  loadRuntime: (id: string) => call<RuntimeSnapshot>("load_runtime", { id }),

  /** 连接按通道聚合后的详情。 */
  loadConnectionChannels: (id: string) =>
    call<ConnectionDetail[]>("load_connection_channels", { id }),

  /** 队列位置列表。 */
  loadQueuePlacements: (id: string) =>
    call<QueuePlacement[]>("load_queue_placements", { id }),

  /** 节点运行时指标 + 判读结论。 */
  loadNodeStats: (id: string) => call<NodeReport>("load_node_stats", { id }),

  /** 关闭一条 AMQP 连接。 */
  closeConnection: (id: string, name: string) =>
    call<void>("close_amqp_connection", { id, name }),

  /** 关闭一个 AMQP 通道。 */
  closeChannel: (id: string, name: string) => call<void>("close_amqp_channel", { id, name }),
};
