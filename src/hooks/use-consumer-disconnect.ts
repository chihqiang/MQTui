import { useMutation, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { messageService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type { DisconnectRequest } from "@/types";

/**
 * 断开消费者。
 *
 * 成功后让连接级缓存全部失效：消费者列表、队列详情里的消费者区块、
 * 队列上的「未确认」数字都会随风而变，逐个失效容易漏。
 */
export function useDisconnectConsumer(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: { queue: string; consumerTag: string; confirm: string }) =>
      messageService.disconnectConsumer({
        connectionId: connectionId as string,
        ...input,
      } satisfies DisconnectRequest),
    onSuccess: (_data, input) => {
      pushToast("success", `已断开 ${input.consumerTag}（队列 ${input.queue}）`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
