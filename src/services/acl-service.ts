/** Kafka ACL 接口，对应 `src-tauri/src/commands/acl.rs`。 */

import { call } from "./ipc";
import type { AclFilter, AclSnapshot } from "@/types/acl";

export const aclService = {
  /**
   * 读取 ACL 规则。
   *
   * 只下发能做精确匹配的字段：名字与主体在界面上是「包含」语义，
   * 下发给服务端只会得到一张空表 —— 那张空表读起来像「一条规则都没有」。
   */
  describeAcls: (id: string, filter?: AclFilter) =>
    call<AclSnapshot>("describe_acls", { id, filter: filter ?? null }),
};
