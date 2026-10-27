import { useInfiniteQuery } from "@tanstack/react-query";

import { messageService, queryKeys } from "@/services";
import { DEFAULT_PAGE_SIZE } from "@/lib/page-size";
import type { MessagePage } from "@/types";

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
  // 条数进 queryKey：分页策略变了就该是另一份缓存，否则会拿到按旧条数切好的页。
  const pageSize = DEFAULT_PAGE_SIZE;

  return useInfiniteQuery({
    queryKey: queryKeys.messages(connectionId, target, pageSize),
    enabled: enabled && Boolean(connectionId) && Boolean(target),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      messageService.listMessages({
        connectionId,
        target,
        limit: pageSize,
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage: MessagePage) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
  });
}
