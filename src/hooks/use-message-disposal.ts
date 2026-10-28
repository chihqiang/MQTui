import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { resendOutcomeMessage } from "@/lib/produce";
import { messageService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type {
  BatchDisposalRequest,
  DeadLetterRequest,
  RedeliverRequest,
  ResendRequest,
} from "@/types";

/**
 * 单条消息的处置能力。
 *
 * 只有 RabbitMQ 有这个动作，`enabled` 由调用方按连接类型决定，
 * 免得在 Kafka 连接上白跑一次必然失败的请求。
 */
export function useDisposalCapabilities(
  connectionId: string | undefined,
  messageId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.disposalCapabilities(connectionId ?? "", messageId ?? ""),
    queryFn: () =>
      messageService.getDisposalCapabilities(connectionId as string, messageId as string),
    enabled: enabled && Boolean(connectionId && messageId),
  });
}

/**
 * 处置动作的公共收尾。
 *
 * 成功后整个连接的缓存一起失效：消息列表少了一条、队列条数变了、
 * 死信队列那头多了一条，逐个失效必漏。
 */
function useDisposalMutation<TInput>(
  mutate: (input: TInput) => Promise<{ exchange: string; routingKey: string }>,
  successMessage: (outcome: { exchange: string; routingKey: string }) => string,
) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: mutate,
    onSuccess: (outcome) => {
      pushToast("success", successMessage(outcome));
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 把「交换机 + routing key」说成一句人话，默认交换机显示成空串不友好。 */
function describeTarget(exchange: string, routingKey: string): string {
  const source = exchange ? exchange : "默认交换机";
  return `${source} / ${routingKey || "(空 routing key)"}`;
}

/** 重新投递到指定交换机。 */
export function useRedeliverMessage(connectionId: string | undefined) {
  return useDisposalMutation(
    (request: RedeliverRequest) =>
      messageService.redeliverMessage({ ...request, connectionId: connectionId as string }),
    (outcome) => `已重新投递到 ${describeTarget(outcome.exchange, outcome.routingKey)}`,
  );
}

/** 移入队列声明的死信交换机。 */
export function useDeadLetterMessage(connectionId: string | undefined) {
  return useDisposalMutation(
    (request: DeadLetterRequest) =>
      messageService.deadLetterMessage({ ...request, connectionId: connectionId as string }),
    (outcome) => `已投进死信 ${describeTarget(outcome.exchange, outcome.routingKey)}`,
  );
}

/**
 * 批量处置。
 *
 * 与单条处置不同，这里**不吃 toast**：一批里有成有败是常态，
 * 一句「失败」或「成功」都会误导人。结果交给调用方原样逐条铺开展示，
 * 缓存失效照旧做——成功的那几条确实已经离开队列了。
 */
export function useBatchDisposeMessages(connectionId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: Omit<BatchDisposalRequest, "connectionId">) =>
      messageService.batchDisposeMessages({
        ...request,
        connectionId: connectionId as string,
      }),
    onSettled: () => {
      // 不管成没成，队列条数与消息列表都可能已经变了，统一失效一次。
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
  });
}

/**
 * 重试「没放回队列」的那批消息。
 *
 * 与批量处置共用同一套逐条结果，但语义完全不同：**只放回、不处置**。
 * 所以缓存失效照做（队列里确实多了几条），但绝不复用 `useBatchDisposeMessages` ——
 * 那个 hook 背后是会发布的命令，混用一次就是把用户没选中的消息投出去。
 */
export function useRetryStrandedMessages(connectionId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: Omit<BatchDisposalRequest, "connectionId">) =>
      messageService.retryStrandedMessages({
        ...request,
        connectionId: connectionId as string,
      }),
    onSettled: () => {
      // 放回之后队列条数会变，别让界面继续显示旧数字。
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
  });
}

/**
 * Kafka 重发。
 *
 * 与 RabbitMQ 的处置分开写，因为消息语义完全不同：重发**不会**减少队列／日志里的
 * 消息条数，只是多了一条新的，所以成功提示必须写清「写到了哪个分区」，
 * 而不是「已移走」那种让人误会的说法。
 */
export function useResendMessage(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (request: ResendRequest) =>
      messageService.resendMessage({ ...request, connectionId: connectionId as string }),
    onSuccess: (outcome) => {
      pushToast("success", resendOutcomeMessage(outcome));
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
