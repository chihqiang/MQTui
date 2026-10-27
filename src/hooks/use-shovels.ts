import { useQuery } from "@tanstack/react-query";

import { queryKeys, shovelService } from "@/services";

/**
 * 铲子运行态。
 *
 * 与参数分开拉：参数是配置（改一次变一次），运行态是会自己变的那一半 ——
 * 隔几秒刷新一次才有意义。缓存窗口给 10 秒，比参数页短。
 */
export function useShovels(connectionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.shovels(connectionId ?? ""),
    queryFn: () => shovelService.listShovels(connectionId as string),
    enabled: Boolean(connectionId) && enabled,
    staleTime: 10_000,
  });
}
