import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { policyService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type { PolicySpec } from "@/types/policy";

/** 策略快照。没配管理 API 时后端直接报错，不走「空列表」这条含糊路径。 */
export function usePolicies(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.policies(connectionId ?? ""),
    queryFn: () => policyService.listPolicies(connectionId as string),
    enabled: Boolean(connectionId),
    // 策略一次拉全量（普通 + 操作员），策略页与参数页来回切不必各拉一次。
    staleTime: 30_000,
  });
}

/**
 * 策略预览。
 *
 * 不做「边打字边预览」：预览要拿全部策略和拓扑（两次请求），
 * 逐字符触发会把管理 API 打满。由用户点「预览影响」显式触发。
 */
export function usePolicyPreview(connectionId: string | undefined) {
  return useMutation({
    mutationFn: (spec: PolicySpec) => policyService.previewPolicy(connectionId as string, spec),
    onError: (error) => useSessionStore.getState().pushToast("error", errorMessage(error)),
  });
}

/** 保存策略。成功后快照直接回填，省一次往返。 */
export function useSavePolicy(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: ({ spec, originalName }: { spec: PolicySpec; originalName?: string }) =>
      policyService.savePolicy(connectionId as string, spec, originalName),
    onSuccess: (snapshot, input) => {
      queryClient.setQueryData(queryKeys.policies(connectionId as string), snapshot);
      const renamed = input.originalName && input.originalName !== input.spec.name;
      pushToast(
        "success",
        renamed
          ? `策略 ${input.originalName} 已重命名为 ${input.spec.name}`
          : `策略 ${input.spec.name} 已保存`,
      );
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/**
 * 删除策略前的后果预检。只在确认框打开时跑。
 *
 * 不缓存也不复用：策略可能刚被人改过，拿旧快照说「只会失去 TTL」是在猜。
 */
export function usePolicyRemovalPreview(connectionId: string | undefined) {
  return useMutation({
    mutationFn: (name: string) => policyService.previewPolicyRemoval(connectionId as string, name),
  });
}

/** 删除策略。 */
export function useDeletePolicy(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (name: string) => policyService.deletePolicy(connectionId as string, name),
    onSuccess: (snapshot, name) => {
      queryClient.setQueryData(queryKeys.policies(connectionId as string), snapshot);
      pushToast("success", `已删除策略 ${name}`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
