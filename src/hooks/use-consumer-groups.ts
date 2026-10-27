import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { consumerService, queryKeys } from "@/services";
import type { ConsumerGroupPage } from "@/types";

/** 单页条数，与后端默认值一致。 */
const PAGE_SIZE = 100;

/**
 * 消费组列表：关键字 + 游标翻页。
 *
 * 关键字进 queryKey，切换搜索词即视为一次新查询，不会和上一次的结果串起来。
 */
export function useConsumerGroups(
  connectionId: string | undefined,
  keyword: string,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.consumerGroups(connectionId ?? "", keyword),
    enabled: Boolean(connectionId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      consumerService.listConsumerGroups({
        connectionId: connectionId as string,
        keyword: keyword || undefined,
        limit: PAGE_SIZE,
        cursor: pageParam,
      }),
    getNextPageParam: (lastPage: ConsumerGroupPage) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
  });
}

/** 单个消费组的成员与滞后明细。 */
export function useConsumerGroup(
  connectionId: string | undefined,
  group: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.consumerGroup(connectionId ?? "", group ?? ""),
    queryFn: () =>
      consumerService.getConsumerGroup(connectionId as string, group as string),
    enabled: Boolean(connectionId) && Boolean(group),
  });
}
