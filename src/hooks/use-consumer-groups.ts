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

/**
 * 采样一个消费组的滞后趋势。
 *
 * 默认不开：这个请求会在后端等满一个采样窗口（5 秒），用户只是想看成员列表时
 * 不该被迫等它。传 `undefined` 表示「还没开始采」。
 */
export function useLagTrend(
  connectionId: string | undefined,
  group: string | undefined,
  windowMs: number | undefined,
) {
  return useQuery({
    queryKey: queryKeys.lagTrend(connectionId ?? "", group ?? "", windowMs ?? 0),
    queryFn: () =>
      consumerService.sampleLagTrend(
        connectionId as string,
        group as string,
        windowMs,
      ),
    enabled: Boolean(connectionId && group && windowMs),
    // 结果只代表那一段时间，不缓存复用。
    gcTime: 0,
    retry: false,
  });
}
