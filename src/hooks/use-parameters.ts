import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { parameterService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type { ParameterComponent, ParameterSpec } from "@/types/parameter";

/** 参数快照。三类分组拉取，权限不足的那一类会落在 `errors` 里而不是整页报错。 */
export function useParameters(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.parameters(connectionId ?? ""),
    queryFn: () => parameterService.listParameters(connectionId as string),
    enabled: Boolean(connectionId),
    // 三类参数一次拉全，窗口与策略页一致。
    staleTime: 30_000,
  });
}

/** 保存参数。成功后快照直接回填，省一次往返。 */
export function useSaveParameter(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: ({ spec, originalName }: { spec: ParameterSpec; originalName?: string }) =>
      parameterService.saveParameter(connectionId as string, spec, originalName),
    onSuccess: (snapshot, input) => {
      queryClient.setQueryData(queryKeys.parameters(connectionId as string), snapshot);
      const renamed = input.originalName && input.originalName !== input.spec.name;
      pushToast(
        "success",
        renamed
          ? `参数 ${input.originalName} 已重命名为 ${input.spec.name}`
          : `参数 ${input.spec.name} 已保存`,
      );
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 删除参数。 */
export function useDeleteParameter(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: ({
      component,
      vhost,
      name,
    }: {
      component: ParameterComponent;
      vhost: string;
      name: string;
    }) => parameterService.deleteParameter(connectionId as string, component, vhost, name),
    onSuccess: (snapshot, input) => {
      queryClient.setQueryData(queryKeys.parameters(connectionId as string), snapshot);
      pushToast("success", `已删除参数 ${input.name}`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
