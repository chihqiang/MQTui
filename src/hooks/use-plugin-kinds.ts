import { useQuery } from "@tanstack/react-query";

import { brokerService, queryKeys } from "@/services";
import type { BrokerKind, BrokerCapability, PluginKind } from "@/types";

/**
 * 中间件能力声明，静态数据，长时间缓存。
 *
 * `gcTime` 必须一起放开：只设 `staleTime` 时数据仍会在组件全部卸载 5 分钟后
 * 被回收，下次挂载 `data` 先变成 `undefined` —— 菜单与命令面板会短暂空一帧。
 * 这份数据永远不变，没有回收的理由。
 */
export function usePluginKinds() {
  return useQuery({
    queryKey: queryKeys.pluginKinds(),
    queryFn: brokerService.listPluginKinds,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** 取某个中间件的能力清单；未加载完成时返回空数组。 */
export function useCapabilities(kind: BrokerKind | undefined): BrokerCapability[] {
  const { data } = usePluginKinds();
  return data?.find((item) => item.kind === kind)?.capabilities ?? [];
}

export function findPluginKind(
  kinds: PluginKind[] | undefined,
  kind: BrokerKind | undefined,
): PluginKind | undefined {
  return kinds?.find((item) => item.kind === kind);
}
