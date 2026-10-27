import { useInfiniteQuery } from "@tanstack/react-query";

import { messageService, queryKeys } from "@/services";
import type { MessagePage } from "@/types";

/** 单页条数，与后端默认值保持一致。 */
const PAGE_SIZE = 100;

interface Options {
  connectionId: string;
  target: string;
  enabled?: boolean;
}

/**
 * 消息分页：第一页取最新，之后顺着游标往前（更旧）翻。
 *
 * 每个 topic / queue 一份缓存，`getNextPageParam` 直接复用后端返回的游标，
 * 前端不自己推算 offset，避免和后端的分页语义绑死。
 */
export function useMessages({ connectionId, target, enabled = true }: Options) {
  return useInfiniteQuery({
    queryKey: queryKeys.messages(connectionId, target),
    enabled: enabled && Boolean(connectionId) && Boolean(target),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      messageService.listMessages({
        connectionId,
        target,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage: MessagePage) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
  });
}
