import { useMemo } from "react";

import { useParameters } from "@/hooks/use-parameters";
import { useTopology } from "@/hooks/use-broker-data";

/**
 * 这台 RabbitMQ 上出现过的 vhost。
 *
 * 没有 `list_vhosts` 命令，也不打算为两处输入框新增一次 IPC —— 队列、交换机、参数
 * 的返回值里本来就带着 vhost，合并起来就是一份够用的候选：**能填的 vhost 一定至少在
 * 其中一处留下过痕迹**（连一个空 vhost 都还没有的集群，此刻也没什么可填的）。
 *
 * 手动输入的入口保留着：vhost 可以在控制台里先建好、再由这里写第一条参数，
 * 那种情况下候选里当然还没有它。
 */
export function useVhosts(connectionId: string | undefined, enabled: boolean): string[] {
  // 参数与拓扑各自有 30 秒缓存，两处输入框共用这一份候选，不会来回打管理 API。
  const { data: parameters } = useParameters(enabled ? connectionId : undefined);
  const { data: topology } = useTopology(connectionId, enabled);

  return useMemo(() => {
    const names = new Set<string>();
    for (const item of topology?.queues ?? []) if (item.vhost) names.add(item.vhost);
    for (const item of topology?.exchanges ?? []) if (item.vhost) names.add(item.vhost);
    for (const item of parameters?.parameters ?? []) if (item.vhost) names.add(item.vhost);
    // 默认 vhost 永远排第一个：它是最常见的取值，也是「留空」的实际含义。
    return ["/", ...[...names].filter((name) => name !== "/")];
  }, [topology, parameters]);
}
