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
  });
}

/** RabbitMQ 拓扑（交换机 + 绑定 + 队列）。 */
export function useTopology(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.topology(id ?? ""),
    queryFn: () => messageService.loadTopology(id as string),
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
