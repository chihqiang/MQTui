import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { clusterService, queryKeys } from "@/services";

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

/** RabbitMQ 节点指标。 */
export function useNodeStats(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.nodeStats(connectionId ?? ""),
    queryFn: () => clusterService.loadNodeStats(connectionId as string),
    enabled: Boolean(connectionId),
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
