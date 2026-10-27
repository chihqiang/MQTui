import { useQuery } from "@tanstack/react-query";

import { queryKeys, quotaService } from "@/services";

/**
 * 配额快照。
 *
 * 缓存重一点：配额由管理员偶尔调整，面板反复去问只会白等一次往返。
 * 但也不做自动刷新 —— 这一屏的用途是「查一下现在限成什么样」，
 * 用户按下刷新才是他要看的新数据。
 */
export function useQuotas(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.quotas(connectionId ?? ""),
    queryFn: () => quotaService.describeClientQuotas(connectionId as string),
    enabled: Boolean(connectionId),
    staleTime: 60_000,
    // 读不到配额是常态（librdkafka 未导出 DescribeClientQuotas），
    // 重试三次只是让用户多等三倍时间看到同一句话。
    retry: 1,
  });
}

/**
 * SCRAM 凭据快照。
 *
 * 与配额分开查询：它们的失败面完全不同，一个失败不该把另一栏也拖成错误态。
 */
export function useScramCredentials(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.scram(connectionId ?? ""),
    queryFn: () => quotaService.describeUserScramCredentials(connectionId as string),
    enabled: Boolean(connectionId),
    staleTime: 60_000,
    retry: 1,
  });
}
