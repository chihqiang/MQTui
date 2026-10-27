import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { adminService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type { PermissionInfo, UserSpec } from "@/types/admin";

/** 账户页快照。一次读全：vhost 汇总 + 用户 + 权限。 */
export function useAdmin(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.admin(connectionId ?? ""),
    queryFn: () => adminService.loadAdmin(connectionId as string),
    enabled: Boolean(connectionId),
    // 账户改动是低频的，30 秒内不必反复打管理 API。
    staleTime: 30_000,
  });
}

/** vhost 的新建 / 改描述。 */
export function useSaveVhost(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: ({ name, description }: { name: string; description: string }) =>
      adminService.saveVhost(connectionId as string, name, description),
    onSuccess: (vhosts, input) => {
      // 只回填 vhost 那一列：用户与权限没动，重拉一次是白花的是三次请求。
      queryClient.setQueryData(queryKeys.admin(connectionId as string), (prev) =>
        prev ? { ...prev, vhosts } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.health(connectionId as string) });
      pushToast("success", `vhost ${input.name} 已保存`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 删除 vhost。不可逆，确认交给页面里的 ConfirmDialog。 */
export function useDeleteVhost(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (name: string) => adminService.deleteVhost(connectionId as string, name),
    onSuccess: (vhosts, name) => {
      queryClient.setQueryData(queryKeys.admin(connectionId as string), (prev) =>
        prev ? { ...prev, vhosts } : prev,
      );
      pushToast("success", `vhost ${name} 已删除`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 用户的新建 / 改名 / 改标签。 */
export function useSaveUser(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: ({ spec, originalName }: { spec: UserSpec; originalName?: string }) =>
      adminService.saveUser(connectionId as string, spec, originalName),
    onSuccess: (outcome, input) => {
      queryClient.setQueryData(queryKeys.admin(connectionId as string), (prev) =>
        prev ? { ...prev, users: outcome.users } : prev,
      );
      const renamed = input.originalName && input.originalName !== input.spec.name;
      pushToast(
        "success",
        renamed
          ? `用户 ${input.originalName} 已改名为 ${input.spec.name}`
          : `用户 ${input.spec.name} 已保存`,
      );
      // 口令太弱只是提醒：服务端收下了，这里也不该假装失败。
      if (outcome.passwordWarning) {
        pushToast("info", `口令提醒：${outcome.passwordWarning}`);
      }
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 删除用户。连带删除它在所有 vhost 上的权限。 */
export function useDeleteUser(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (name: string) => adminService.deleteUser(connectionId as string, name),
    onSuccess: (users, name) => {
      queryClient.setQueryData(queryKeys.admin(connectionId as string), (prev) =>
        prev ? { ...prev, users } : prev,
      );
      pushToast("success", `用户 ${name} 已删除`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 授权 / 改权限。 */
export function useSavePermission(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (permission: PermissionInfo) =>
      adminService.savePermission(connectionId as string, permission),
    onSuccess: (permissions, input) => {
      queryClient.setQueryData(queryKeys.admin(connectionId as string), (prev) =>
        prev ? { ...prev, permissions } : prev,
      );
      pushToast("success", `${input.user} 在 ${input.vhost} 上的权限已保存`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 撤销权限。 */
export function useDeletePermission(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: ({ user, vhost }: { user: string; vhost: string }) =>
      adminService.deletePermission(connectionId as string, user, vhost),
    onSuccess: (permissions, input) => {
      queryClient.setQueryData(queryKeys.admin(connectionId as string), (prev) =>
        prev ? { ...prev, permissions } : prev,
      );
      pushToast("success", `已撤销 ${input.user} 在 ${input.vhost} 上的权限`);
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
