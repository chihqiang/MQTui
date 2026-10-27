import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { messageService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type { BindingKey, BindingSpec, ExchangeSpec } from "@/types";

/** 队列详情：点开弹窗才请求，列表阶段不背这个体积。 */
export function useQueueDetail(connectionId: string | undefined, queue: string | undefined) {
  return useQuery({
    queryKey: queryKeys.queue(connectionId ?? "", queue ?? ""),
    queryFn: () => messageService.getQueue(connectionId as string, queue as string),
    enabled: Boolean(connectionId && queue),
  });
}

/**
 * 写操作的公共收尾：成功提示 + 失效相关缓存。
 *
 * 清空 / 删除都会改变队列列表和拓扑，两个 key 一起失效，
 * 否则用户会看到「队列已删除但列表还在」。
 */
function useWriteMutation<TInput>(
  mutate: (input: TInput) => Promise<unknown>,
  successMessage: (input: TInput) => string,
) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: mutate,
    onSuccess: (_data, input) => {
      pushToast("success", successMessage(input));
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
    // 错误统一走 toast：删除被拒（队列非空）是最常见的分支，不该占满整页。
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 清空队列消息。 */
export function usePurgeQueue(connectionId: string | undefined) {
  return useWriteMutation(
    (queue: string) => messageService.purgeQueue(connectionId as string, queue),
    (queue) => `已清空 ${queue}`,
  );
}

/** 删除队列。 */
export function useDeleteQueue(connectionId: string | undefined) {
  return useWriteMutation(
    (queue: string) => messageService.deleteQueue(connectionId as string, queue),
    (queue) => `已删除 ${queue}`,
  );
}

/** 新建交换机。 */
export function useCreateExchange(connectionId: string | undefined) {
  return useWriteMutation(
    (spec: ExchangeSpec) => messageService.createExchange(connectionId as string, spec),
    (spec) => `已创建交换机 ${spec.name}`,
  );
}

/** 删除交换机。绑定未解除时服务端会拒绝，错误经 toast 原样透出。 */
export function useDeleteExchange(connectionId: string | undefined) {
  return useWriteMutation(
    (input: { name: string; internal: boolean }) =>
      messageService.deleteExchange(connectionId as string, input.name, input.internal),
    (input) => `已删除交换机 ${input.name || "(默认交换机)"}`,
  );
}

/** 新建绑定。 */
export function useCreateBinding(connectionId: string | undefined) {
  return useWriteMutation(
    (spec: BindingSpec) => messageService.createBinding(connectionId as string, spec),
    (spec) => `已绑定 ${spec.source || "(默认交换机)"} → ${spec.destination.name}`,
  );
}

/** 删除绑定。 */
export function useDeleteBinding(connectionId: string | undefined) {
  return useWriteMutation(
    (key: BindingKey) => messageService.deleteBinding(connectionId as string, key),
    (key) => `已解除 ${key.source || "(默认交换机)"} → ${key.destination}`,
  );
}
