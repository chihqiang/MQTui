import { useMutation, useQueryClient } from "@tanstack/react-query";

import { aclService, queryKeys } from "@/services";
import type { AclWriteRequest } from "@/types/acl";

/**
 * ACL 的写入。
 *
 * 预演也走 mutation 而不是 query：它是一份**当时**的结论，不是可缓存的资源。
 * 缓存一份预演等于把「几十秒前的集群」当成现在 —— 而这段时间里别人可能刚改过规则。
 */
export function useAclWrite(connectionId: string | undefined) {
  const client = useQueryClient();

  /** 提交后所有 ACL 查询一起失效：筛选条件不同就是不同的缓存键，只失效当前那份会漏。 */
  const invalidate = () => {
    if (!connectionId) return;
    void client.invalidateQueries({
      queryKey: [...queryKeys.connection(connectionId), "acls"],
    });
  };

  const previewCreate = useMutation({
    mutationFn: (request: AclWriteRequest) =>
      aclService.previewCreate(connectionId as string, request),
  });

  const previewDelete = useMutation({
    mutationFn: (request: AclWriteRequest) =>
      aclService.previewDelete(connectionId as string, request),
  });

  const commitCreate = useMutation({
    mutationFn: (request: AclWriteRequest) =>
      aclService.commitCreate(connectionId as string, request),
    onSuccess: invalidate,
  });

  const commitDelete = useMutation({
    mutationFn: (request: AclWriteRequest) =>
      aclService.commitDelete(connectionId as string, request),
    onSuccess: invalidate,
  });

  return { previewCreate, previewDelete, commitCreate, commitDelete };
}
