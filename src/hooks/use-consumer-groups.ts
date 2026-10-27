import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { consumerService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
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

/**
 * 采样一个消费组的队头阻塞。
 *
 * 与滞后趋势一样默认不开：这个请求会在后端等满一个窗口。
 * 结果只代表那一段时间，不缓存复用 —— 十分钟后再看还是那份旧名单，
 * 比看不到更糟。
 */
export function useGroupBlock(
  connectionId: string | undefined,
  group: string | undefined,
  windowMs: number | undefined,
) {
  return useQuery({
    queryKey: queryKeys.groupBlock(connectionId ?? "", group ?? "", windowMs ?? 0),
    queryFn: () =>
      consumerService.sampleBlock(connectionId as string, group as string, windowMs),
    enabled: Boolean(connectionId && group && windowMs),
    gcTime: 0,
    retry: false,
  });
}

/**
 * 删除消费组。
 *
 * 部分成功不弹错误：结果里已经写清「谁删了、谁没删、为什么」，
 * 弹一个统一的失败提示反而把这份信息盖住。
 */
export function useDeleteConsumerGroups(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (groups: string[]) =>
      consumerService.deleteGroups(connectionId as string, groups),
    onSuccess: (outcome) => {
      pushToast(outcome.failed.length ? "info" : "success", outcome.detail);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.consumerGroups(connectionId ?? "", ""),
      });
      // 组没了，它的详情与趋势缓存都失去意义。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.connection(connectionId ?? ""),
        predicate: (query) =>
          query.queryKey.includes("consumer-group") ||
          query.queryKey.includes("lag-trend") ||
          query.queryKey.includes("group-block"),
      });
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
