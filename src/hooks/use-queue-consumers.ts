import { useQuery } from "@tanstack/react-query";

import { messageService, queryKeys } from "@/services";

/**
 * 消费者连线。
 *
 * 一次拉整个 vhost 的队列与消费者，队列详情里的「谁在消费」也复用它——
 * 为单个队列再开一次 `/api/consumers` 请求没有意义，数据本来就是全量的。
 */
export function useQueueConsumers(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.queueConsumers(connectionId ?? ""),
    queryFn: () => messageService.listQueueConsumers(connectionId as string),
    enabled: Boolean(connectionId),
    // `/api/consumers` 是全量请求，几十个队列时响应体不小。窗口给 30 秒：
    // 消费者列表 / 运行时 / 队列详情三页共用同一份，切来切去不该各拉一次。
    staleTime: 30_000,
  });
}
