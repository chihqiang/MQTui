import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys, resetService } from "@/services";
import type { ResetTarget } from "@/types";

/**
 * 位点重置预览。
 *
 * 只在用户明确选了目标之后才发请求：预览本身要逐分区查三个位点，
 * 一进页面就按默认目标跑一遍，等于替用户做了「重置到最早」这个决定的前半段。
 */
export function useResetPreview(
  connectionId: string | undefined,
  group: string | undefined,
  topic: string | undefined,
  target: ResetTarget,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.resetPreview(
      connectionId ?? "",
      group ?? "",
      topic ?? "",
      target,
    ),
    queryFn: () =>
      resetService.preview(connectionId as string, group as string, topic as string, target),
    enabled: Boolean(connectionId && group && topic) && enabled,
    // 计划不允许「重试出另一个结果」：位点在变，重试只会让对照表前后不一致。
    retry: false,
  });
}

/** 执行顺序说明。 */
export function useResetPhases(connectionId: string | undefined, group: string | undefined) {
  return useQuery({
    queryKey: queryKeys.resetPhases(connectionId ?? "", group ?? ""),
    queryFn: () => resetService.phases(connectionId as string, group as string),
    enabled: Boolean(connectionId && group),
    retry: false,
  });
}

/** 提交位点。 */
export function useCommitReset(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { group: string; topic: string; plan: import("@/types").ResetPlan }) =>
      resetService.commit(connectionId as string, input.group, input.topic, input.plan),
    onSuccess: () => {
      // 位点变了，消费组详情与滞后量全都要重算。
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection(connectionId ?? "") });
    },
  });
}
