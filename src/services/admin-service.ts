/** RabbitMQ 账户管理接口，对应 `src-tauri/src/commands/admin.rs`。 */

import { call } from "./ipc";
import type { AdminSnapshot, PermissionInfo, UserSaveOutcome, UserSpec, VhostRow } from "@/types/admin";

export const adminService = {
  /** 一次读全：vhost 汇总 + 用户 + 权限。 */
  loadAdmin: (id: string) => call<AdminSnapshot>("load_admin", { id }),

  /** 新建 / 修改 vhost。管理 API 是 PUT：已存在时是「改描述」。 */
  saveVhost: (id: string, name: string, description: string) =>
    call<VhostRow[]>("save_vhost", { id, name, description }),

  /** 删除 vhost。不可逆：队列、消息、权限、策略一起消失。 */
  deleteVhost: (id: string, name: string) => call<VhostRow[]>("delete_vhost", { id, name }),

  /** 新建 / 修改用户。`originalName` 非空表示改名（先建新的、再删旧的）。 */
  saveUser: (id: string, spec: UserSpec, originalName?: string) =>
    call<UserSaveOutcome>("save_user", { id, spec, originalName: originalName ?? null }),

  deleteUser: (id: string, name: string) => call<AdminSnapshot["users"]>("delete_user", { id, name }),

  /** 授权 / 改权限。三段覆盖写入，没写的那段会被置空。 */
  savePermission: (id: string, permission: PermissionInfo) =>
    call<PermissionInfo[]>("save_permission", { id, permission }),

  /** 撤销权限：该用户在这个 vhost 上连已有的消息都读不到。 */
  deletePermission: (id: string, user: string, vhost: string) =>
    call<PermissionInfo[]>("delete_permission", { id, user, vhost }),
};
