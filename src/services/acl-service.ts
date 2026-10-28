/** Kafka ACL 接口，对应 `src-tauri/src/commands/acl.rs`。 */

import { call } from "./ipc";
import type {
  AclChangePlan,
  AclFilter,
  AclSnapshot,
  AclWriteReport,
  AclWriteRequest,
} from "@/types/acl";

export const aclService = {
  /**
   * 读取 ACL 规则。
   *
   * 只下发能做精确匹配的字段：名字与主体在界面上是「包含」语义，
   * 下发给服务端只会得到一张空表 —— 那张空表读起来像「一条规则都没有」。
   */
  describeAcls: (id: string, filter?: AclFilter) =>
    call<AclSnapshot>("describe_acls", { id, filter: filter ?? null }),

  /**
   * 预演新增。
   *
   * 后端会读一次集群上的**全部**规则再比对，所以这一步永远比界面上的表更新 ——
   * 拿筛选后的表去比对，会把早就存在的规则报成「新增」。
   */
  previewCreate: (id: string, request: AclWriteRequest) =>
    call<AclChangePlan>("preview_acl_create", { id, request }),

  commitCreate: (id: string, request: AclWriteRequest) =>
    call<AclWriteReport>("commit_acl_create", { id, request }),

  previewDelete: (id: string, request: AclWriteRequest) =>
    call<AclChangePlan>("preview_acl_delete", { id, request }),

  commitDelete: (id: string, request: AclWriteRequest) =>
    call<AclWriteReport>("commit_acl_delete", { id, request }),
};
