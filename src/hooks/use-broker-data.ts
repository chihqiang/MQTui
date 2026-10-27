import { useQuery } from "@tanstack/react-query";

import { brokerService, messageService, queryKeys } from "@/services";
import type { BrokerKind } from "@/types";
import type { OrphanScanScope } from "@/types/orphan";

/** 概览。 */
export function useOverview(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.overview(id ?? ""),
    queryFn: () => brokerService.loadOverview(id as string),
    enabled: Boolean(id),
  });
}

/** Kafka 主题列表。 */
export function useTopics(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.topics(id ?? ""),
    queryFn: () => messageService.listTopics(id as string),
    enabled: enabled && Boolean(id),
  });
}

/** RabbitMQ 队列列表。 */
export function useQueues(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.queues(id ?? ""),
    queryFn: () => messageService.listQueues(id as string),
    enabled: enabled && Boolean(id),
    // 队列、拓扑、消费者连线三份数据都在管理 API 上一次拉全，本身不便宜。
    // 窗口给 30 秒：切页面回来看的还是这一份，写操作会显式失效。
    staleTime: 30_000,
  });
}

/** RabbitMQ 拓扑（交换机 + 绑定 + 队列）。 */
export function useTopology(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.topology(id ?? ""),
    queryFn: () => messageService.loadTopology(id as string),
    enabled: enabled && Boolean(id),
    // 管理 API 全量快照，代价不小；页面间来回切不该各拉一次。
    staleTime: 30_000,
  });
}

/** RabbitMQ 拓扑图：分层布局 + 连线。布局在后端算好，前端只画。 */
export function useTopologyGraph(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.topologyGraph(id ?? ""),
    queryFn: () => messageService.loadTopologyGraph(id as string),
    enabled: enabled && Boolean(id),
  });
}

/** 消费者连线图：交换机 → 队列 → 消费者连接。三份数据由后端一次取齐。 */
export function useConsumerGraph(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.consumerGraph(id ?? ""),
    queryFn: () => messageService.loadConsumerGraph(id as string),
    enabled: enabled && Boolean(id),
  });
}

/** 交换机到队列的路由估算。依赖管理 API，需要 RabbitMQ 连接。 */
export function useTopologyInsight(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.topologyInsight(id ?? ""),
    queryFn: () => messageService.loadTopologyInsight(id as string),
    enabled: enabled && Boolean(id),
  });
}

/** 无消费组主题的候选主题名。元数据请求，代价与主题数无关，进页面就可以拉。 */
export function useOrphanCandidates(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.orphanCandidates(id ?? ""),
    queryFn: () => messageService.listOrphanCandidates(id as string),
    enabled: enabled && Boolean(id),
    // 主题列表变化不会太频繁，切页面回来不必重拉。
    staleTime: 60_000,
  });
}

/**
 * 按范围扫描无消费组主题。
 *
 * `scope` 为空时不自动跑：全量扫描是「主题数 × 分区数」次水位请求，几十秒起步。
 * 让它由用户显式触发（`enabled` 由 `hasScanned` 控制），而不是进页面就卡住。
 */
export function useOrphanTopics(
  id: string | undefined,
  scope: OrphanScanScope,
  enabled: boolean,
) {
  const scopeKey = `${(scope.topics ?? []).join(",")}|${scope.prefix ?? ""}`;
  return useQuery({
    queryKey: queryKeys.orphanTopics(id ?? "", scopeKey),
    queryFn: () => messageService.listOrphanTopics(id as string, scope),
    enabled: enabled && Boolean(id),
  });
}

/** 按能力开关查询，避免在 Kafka 连接上误发 RabbitMQ 请求。 */
export function isQueueBroker(kind: BrokerKind | undefined): boolean {
  return kind === "rabbitMq";
}
