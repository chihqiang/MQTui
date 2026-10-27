import { useQuery } from "@tanstack/react-query";

import { queryKeys, aclService } from "@/services";
import { serverFilter } from "@/lib/acl";
import type { AclFilter } from "@/types/acl";

/** 过滤器指纹：只把能下发到服务端的字段算进去，缓存才不会被本地筛选搅乱。 */
function filterKey(filter: AclFilter): string {
  const remote = serverFilter(filter);
  return [remote.resourceType ?? "", remote.operation ?? "", remote.permission ?? ""].join("|");
}

/**
 * ACL 规则。
 *
 * 缓存重一点：ACL 由管理员偶尔调整，面板反复去问只会白等一次往返；
 * 也不自动刷新 —— 这一屏的用途是「查一下现在谁被允许做什么」，
 * 用户按下刷新才是他要看的新数据。
 */
export function useAcls(connectionId: string | undefined, filter: AclFilter) {
  return useQuery({
    queryKey: queryKeys.acls(connectionId ?? "", filterKey(filter)),
    queryFn: () => aclService.describeAcls(connectionId as string, serverFilter(filter)),
    enabled: Boolean(connectionId),
    staleTime: 60_000,
    // 「这台 broker 没开授权」是稳定答案，重试三次只是让人多等三倍时间看同一句话。
    retry: 1,
  });
}
