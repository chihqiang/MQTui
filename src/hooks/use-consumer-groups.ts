import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { consumerService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import { groupRemovalKey } from "@/lib/group-removal";
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
 * 成员分区归属。
 *
 * 和详情一样是随弹窗打开就发的查询 —— 但它只读一次组成员快照，
 * 不涉及位点与水位，比详情轻得多。失败时界面说「归属未知」，
 * 不拿一张空表冒充「没有分区」。
 */
export function useConsumerGroupAssignment(
  connectionId: string | undefined,
  group: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.groupAssignment(connectionId ?? "", group ?? ""),
    queryFn: () =>
      consumerService.getAssignment(connectionId as string, group as string),
    enabled: Boolean(connectionId) && Boolean(group),
    // 归属是一次快照：再均衡期间读到的可能已经是旧分配，别长期缓存。
    gcTime: 30_000,
    // 读不懂分配时后端不报错（那是数据事实），真报错多半是组名过期，重试无益。
    retry: false,
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
 * 删除前的预检。
 *
 * `groups` 为空表示弹窗没开或没选东西，此时不发请求 —— 预检的意义是
 * 在确认框里提前说清后果，没人看着的时候问它只是白读一次组列表。
 *
 * `gcTime: 0`：勾选一变就是另一份名单，旧结论留着只会被误读成新结论。
 */
export function useGroupRemovalPreflight(
  connectionId: string | undefined,
  groups: string[],
) {
  const key = groupRemovalKey(groups);
  return useQuery({
    queryKey: queryKeys.groupRemovalPreflight(connectionId ?? "", key),
    queryFn: () =>
      consumerService.preflightRemoval(connectionId as string, groups),
    enabled: Boolean(connectionId) && groups.length > 0,
    gcTime: 0,
    // 预检读不到成员是常态（组名过期、权限受限），重试三次只是多等三倍时间
    // 看到同一句话；真删的时候服务端还会再拦一次。
    retry: 1,
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
