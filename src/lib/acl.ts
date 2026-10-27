/**
 * ACL 的判读：纯函数，不发请求。
 *
 * 后端把规则摆好了，这里只负责「该怎么读」：一条规则管的是哪些资源、
 * 它会不会把读规则的人自己也拦在外面、筛完之后还剩几条。
 * 判定口径与 `src-tauri/src/domain/acl.rs` 保持一致，改一边记得改另一边。
 */

import {
  ACL_OPERATION_LABEL,
  ACL_PERMISSION_LABEL,
  ACL_RESOURCE_LABEL,
} from "../types/acl.ts";
import type {
  AclEntry,
  AclFilter,
  AclOperation,
  AclPattern,
  AclPermission,
  AclResourceType,
  AclSnapshot,
  PrincipalAcl,
} from "../types/acl.ts";

/** 资源在界面上的写法：`主题 payments-`（前缀）而不是只给个名字。 */
export function resourceLabel(entry: AclEntry): string {
  const kind = ACL_RESOURCE_LABEL[entry.resourceType];
  switch (entry.pattern) {
    case "wildcard":
      return kind;
    case "prefixed":
      return `${kind} ${entry.resourceName}`;
    default:
      // 集群级资源的名字本来就是 `kafka-cluster`，读出来没有意义。
      return entry.resourceType === "cluster" ? kind : `${kind} ${entry.resourceName}`;
  }
}

/** 主体去掉 `User:` 前缀；非 `User:` 主体原样返回。 */
export function principalName(principal: string): string {
  const index = principal.indexOf(":");
  return index === -1 ? principal : principal.slice(index + 1);
}

/** 匹配方式的中文名。 */
export function patternLabel(pattern: AclPattern): string {
  return pattern === "wildcard" ? "全部资源" : pattern === "prefixed" ? "前缀匹配" : "精确匹配";
}

/**
 * 这条规则能不能连「读规则的人」自己也管住。
 *
 * 集群级资源上的拒绝会命中所有请求，包括读 ACL 这一条 —— 这是自锁 ACL 的
 * 经典做法。界面上要单独提醒，否则改错的下一步是「面板突然什么都读不到」，
 * 看起来像 bug。
 */
export function blocksIntrospection(entry: AclEntry): boolean {
  return (
    entry.permission === "deny" &&
    entry.resourceType === "cluster" &&
    (entry.operation === "all" ||
      entry.operation === "describe" ||
      entry.operation === "describeConfigs") &&
    (entry.host === "*" || entry.host === "0.0.0.0")
  );
}

/** 按主体分组。排序跟后端一致：主体字典序，组内按资源类型 / 名字 / 操作。 */
export function byPrincipal(entries: AclEntry[]): PrincipalAcl[] {
  const groups: PrincipalAcl[] = [];
  for (const entry of entries) {
    const found = groups.find((group) => group.principal === entry.principal);
    if (found) {
      found.entries.push(entry);
    } else {
      groups.push({ principal: entry.principal, entries: [entry] });
    }
  }
  for (const group of groups) {
    group.entries.sort((left, right) => {
      const order = left.resourceType.localeCompare(right.resourceType);
      if (order !== 0) return order;
      const byName = left.resourceName.localeCompare(right.resourceName);
      if (byName !== 0) return byName;
      return left.operation.localeCompare(right.operation);
    });
  }
  groups.sort((left, right) => left.principal.localeCompare(right.principal));
  return groups;
}

/** 可能把自己锁在外面的规则。要排在表格前面提示。 */
export function selfLockRisks(snapshot: AclSnapshot): AclEntry[] {
  return snapshot.entries.filter(blocksIntrospection);
}

/** 拒绝规则的条数。 */
export function denyCount(snapshot: AclSnapshot): number {
  return snapshot.entries.filter((entry) => entry.permission === "deny").length;
}

/**
 * 一句话结论。
 *
 * 三种状态必须分开说：读不到 / 没有任何规则 / 有 N 条。
 * 把「读不到」说成「没有 ACL」是本页最容易犯的错 —— 它会让人以为
 * 集群对所有人敞开，而真实情况可能只是这台 broker 没开授权。
 */
export function aclVerdict(snapshot: AclSnapshot): string {
  if (snapshot.unsupported) return "读不到 ACL：这台 broker 不支持";
  if (snapshot.entries.length === 0) return "没有任何 ACL：所有操作都不会被授权器拦截";
  const principals = byPrincipal(snapshot.entries).length;
  const denied = denyCount(snapshot);
  return denied > 0
    ? `${snapshot.entries.length} 条规则 · ${principals} 个主体 · 其中 ${denied} 条是拒绝`
    : `${snapshot.entries.length} 条规则 · ${principals} 个主体`;
}

/** 过滤器是否为空。 */
export function isFilterEmpty(filter: AclFilter): boolean {
  return Object.values(filter).every((value) => value === undefined);
}

/**
 * 过滤器的中文描述。只筛了就必须说出来 —— 过滤后的表最容易被误读成全量。
 */
export function describeFilter(filter: AclFilter): string {
  if (isFilterEmpty(filter)) return "全部规则";
  const parts: string[] = [];
  if (filter.resourceType) parts.push(ACL_RESOURCE_LABEL[filter.resourceType]);
  if (filter.resourceName) parts.push(`名字含 ${filter.resourceName}`);
  if (filter.principal) parts.push(`主体含 ${filter.principal}`);
  if (filter.operation) parts.push(ACL_OPERATION_LABEL[filter.operation]);
  if (filter.permission) parts.push(ACL_PERMISSION_LABEL[filter.permission]);
  return `筛选：${parts.join(" · ")}`;
}

/**
 * 本地筛一遍。
 *
 * 服务端只做精确匹配，用户想搜「中间那段」时得靠这里。名字与主体忽略大小写，
 * 其余字段严格相等 —— 把 `read` 也做成模糊匹配只会搜出一堆不相干的规则。
 */
export function matchesFilter(entry: AclEntry, filter: AclFilter): boolean {
  const contains = (value: string, needle: string | undefined): boolean =>
    !needle || value.toLowerCase().includes(needle.toLowerCase());

  return (
    (!filter.resourceType || entry.resourceType === filter.resourceType) &&
    contains(entry.resourceName, filter.resourceName) &&
    contains(entry.principal, filter.principal) &&
    (!filter.operation || entry.operation === filter.operation) &&
    (!filter.permission || entry.permission === filter.permission)
  );
}

/** 按过滤器筛规则。 */
export function filterEntries(entries: AclEntry[], filter: AclFilter): AclEntry[] {
  return entries.filter((entry) => matchesFilter(entry, filter));
}

/**
 * 过滤器里可以直接下发给服务端的部分。
 *
 * 名字与主体是「包含」语义，服务端只做精确匹配 —— 下发下去会得到一张空表，
 * 那张空表读起来像「一条规则都没有」。所以这两项只在本地筛，其余字段照发。
 */
export function serverFilter(filter: AclFilter): AclFilter {
  return {
    resourceType: filter.resourceType,
    operation: filter.operation,
    permission: filter.permission,
  };
}

/** 操作下拉的顺序：最常见的读写在最前，`all` 放最后（它是概括，不是日常操作）。 */
export const ACL_OPERATION_OPTIONS: AclOperation[] = [
  "read",
  "write",
  "describe",
  "create",
  "delete",
  "alter",
  "describeConfigs",
  "alterConfigs",
  "clusterAction",
  "idempotentWrite",
  "all",
];

/** 权限下拉。 */
export const ACL_PERMISSION_OPTIONS: AclPermission[] = ["allow", "deny"];

/** 资源类型下拉。 */
export const ACL_RESOURCE_TYPES: AclResourceType[] = ["topic", "group", "cluster", "broker"];
