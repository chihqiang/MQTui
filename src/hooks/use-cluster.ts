import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { clusterService, queryKeys } from "@/services";
import type { BrokerKind } from "@/types";

/**
 * 集群视图。
 *
 * 不做定时轮询：一次请求要拉元数据或整份 `/api/nodes`，
 * 而集群状态的变化通常由用户的动作（扩容、重启）触发，不是随机发生的。
 */
export function useCluster(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.cluster(connectionId ?? ""),
    queryFn: () => clusterService.loadCluster(connectionId as string),
    enabled: Boolean(connectionId),
  });
}

/** RabbitMQ 运行时：连接、通道、队列位置。 */
export function useRuntime(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runtime(connectionId ?? ""),
    queryFn: () => clusterService.loadRuntime(connectionId as string),
    enabled: Boolean(connectionId),
  });
}

/**
 * 节点运行时指标（内存 / 磁盘 / fd）。
 *
 * 只有 RabbitMQ 有这套指标，Kafka 的节点卡靠元数据就够了。所以 `enabled`
 * 里带了中间件判断：对 Kafka 也发这个请求，只会换来一句永远成立的
 * 「节点指标读取失败」，以及一份空的 `verdicts` —— 后者会让「只看需处理」
 * 这个筛选静默失效（controller 缺失、副本掉队都筛不出来）。
 *
 * `null` 表示「中间件还没读出来」：此时也不发，避免刚进页面时先打一次空请求。
 */
export function useNodeStats(connectionId: string | undefined, kind: BrokerKind | null) {
  return useQuery({
    queryKey: queryKeys.nodeStats(connectionId ?? ""),
    queryFn: () => clusterService.loadNodeStats(connectionId as string),
    enabled: Boolean(connectionId) && kind !== null,
    // Kafka 这边后端会回空报告：没必要每次进页面都再问一遍。
    staleTime: kind === "kafka" ? Infinity : 0,
  });
}

/**
 * 断开连接 / 关闭通道。
 *
 * 两个动作都用同一种失效策略：把整个连接的查询前缀打掉。
 * 关掉一个通道会让「队列位置」里的消费者数、队列页的堆积量一起变，
 * 精确失效在这里只是给自己找漏掉的麻烦。
 */
export function useRuntimeActions(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.connection(connectionId ?? "") });

  const closeConnection = useMutation({
    mutationFn: (name: string) => clusterService.closeConnection(connectionId as string, name),
    onSuccess: invalidate,
  });

  const closeChannel = useMutation({
    mutationFn: (name: string) => clusterService.closeChannel(connectionId as string, name),
    onSuccess: invalidate,
  });

  return { closeConnection, closeChannel };
}
