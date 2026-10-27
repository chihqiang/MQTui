import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { brokerService, queryKeys } from "@/services";
import { writeAllowed } from "@/types/health";

/**
 * 连接健康检查。
 *
 * 不做定时轮询：探测里包含一次管理 API 全量请求，几十秒一次的轮询对小集群也是浪费。
 * 进页面探一次，用户手动刷新或写操作之后都会重新探测。
 */
export function useHealth(connectionId: string | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.health(connectionId ?? ""),
    queryFn: () => brokerService.checkHealth(connectionId as string),
    enabled: Boolean(connectionId),
    // 连不上时没必要反复重试，用户需要看到的是「连不上」本身。
    retry: false,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.health(connectionId ?? "") });
  }, [connectionId, queryClient]);

  return { ...query, refresh, canWrite: writeAllowed(query.data) };
}
