import { useQuery } from "@tanstack/react-query";

import { messageService, queryKeys } from "@/services";

/**
 * 队列级消费者归属。
 *
 * 一次四个请求（队列、消费者、连接、channel），比单纯的消费者列表重，
 * 但窗口给 20 秒：断开一个消费者要回来看结果，来回切页不该每切一次拉一遍。
 */
export function useConsumerOwnership(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.consumerOwnership(connectionId ?? ""),
    queryFn: () => messageService.listConsumerOwnership(connectionId as string),
    enabled: Boolean(connectionId),
    staleTime: 20_000,
  });
}
