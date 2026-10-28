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
  AclChange,
  AclChangePlan,
  AclChangeVerdict,
  AclEntry,
  AclFilter,
  AclOperation,
  AclPattern,
  AclPermission,
  AclResourceType,
  AclSnapshot,
  AclWriteReport,
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

/**
 * 变更预演的判读。与 `src-tauri/src/domain/acl.rs` 保持同一套口径，
 * 改一边记得改另一边。
 *
 * 后端已经算好了每条规则的处境与理由，这里只做两件事：
 * 把它们排成能读的顺序，以及说清「提交按钮该不该灰」。
 */

/** 结论的中文名。 */
export const ACL_CHANGE_LABEL: Record<AclChangeVerdict, string> = {
  new: "新增",
  exists: "已存在",
  conflicts: "冲突",
  superseded: "被覆盖",
};

/**
 * 结论的语气。
 *
 * 冲突用危险色、被覆盖用警告色：「被覆盖」看起来无害，实际上提交了也不生效 ——
 * 用中性色会让人以为它跟「新增」是一回事。
 */
export function changeTone(verdict: AclChangeVerdict): "danger" | "warning" | "success" | "neutral" {
  switch (verdict) {
    case "conflicts":
      return "danger";
    case "superseded":
      return "warning";
    case "new":
      return "success";
    default:
      return "neutral";
  }
}

/**
 * 预演的一句话结论。
 *
 * 三种状态分开说：没有要提交的 / 全都没变化 / 有 N 条会真的改变集群。
 * 把「已存在」混进「新增」会让界面报出一个虚高的数字，用户按那个数字判断风险。
 */
export function planVerdict(plan: AclChangePlan): string {
  if (plan.changes.length === 0) return "没有要提交的规则";
  if (plan.effective === 0) return `${plan.changes.length} 条规则全都已经在集群上，提交不会改变任何东西`;
  const conflicts = plan.changes.filter((change) => change.verdict === "conflicts").length;
  const base = `${plan.changes.length} 条规则，其中 ${plan.effective} 条会真的改变集群`;
  return conflicts > 0 ? `${base}，${conflicts} 条与现有规则冲突` : base;
}

/**
 * 提交按钮能不能按。
 *
 * 有拦路风险时**不**禁用，而是要求用户先勾一个「我知道」——禁用会让一个
 * 合法的操作彻底做不了，而这类风险（比如删掉一条集群级拒绝）有时正是要做的。
 */
export function canSubmit(plan: AclChangePlan | undefined, acknowledged: boolean): boolean {
  if (!plan || plan.changes.length === 0) return false;
  if (plan.effective === 0) return false;
  return plan.blockers.length === 0 || acknowledged;
}

/** 预演里有没有拦路风险。 */
export function hasBlockers(plan: AclChangePlan | undefined): boolean {
  return Boolean(plan?.blockers.length);
}

/**
 * 提交前必须手打的名字：主体名（去掉 `User:` 前缀）。
 *
 * 一次只能改一个主体 —— 跨主体提交时「手打主体名」这道确认只能对上其中一个，
 * 另一个等于没确认。后端也会拦，这里只是别让用户白按一次按钮。
 */
export function confirmTarget(entries: AclEntry[]): string | null {
  const principals = new Set(entries.map((entry) => entry.principal));
  if (principals.size !== 1) return null;
  return principalName(entries[0].principal);
}

/** 待提交的规则里涉及几个主体。跨主体时提交按钮必须禁用并说明原因。 */
export function entryPrincipalCount(entries: AclEntry[]): number {
  return new Set(entries.map((entry) => entry.principal)).size;
}

/**
 * 从一条现有规则生成「反向操作」的规则：删掉它，或者翻成相反权限。
 *
 * 这是这一屏最常用的两个动作 —— 把一条允许改成拒绝、把一条规则删掉。
 * 都由现有规则派生，不需要用户重新填一遍六个字段。
 */
export function invertPermission(entry: AclEntry): AclEntry {
  return { ...entry, permission: entry.permission === "allow" ? "deny" : "allow" };
}

/** 新建一条规则的默认值：主体为空，其余按最常见的读写来。 */
export function blankEntry(principal = "User:"): AclEntry {
  return {
    resourceType: "topic",
    resourceName: "",
    pattern: "literal",
    principal,
    host: "*",
    operation: "read",
    permission: "allow",
  };
}

/**
 * 一条规则的界面指纹。与后端 `acl_entry_fingerprint` 用处相同：
 * 表格 key 与勾选状态都靠它，顺序变了会让勾选跳到别的行上。
 */
export function entryFingerprint(entry: AclEntry): string {
  return [
    entry.principal,
    entry.host,
    entry.resourceName,
    entry.pattern,
    entry.operation,
    entry.permission,
    entry.resourceType,
  ].join("|");
}

/** 提交回执的一句话结论。 */
export function reportVerdict(report: AclWriteReport): string {
  const failed = report.outcomes.filter((item) => !item.ok).length;
  if (report.outcomes.length === 0) return "没有任何规则被提交";
  if (failed === 0) return `${report.outcomes.length} 条规则已全部生效`;
  return `${report.outcomes.length} 条规则里 ${report.outcomes.length - failed} 条成功、${failed} 条失败`;
}

/**
 * 失败的那几条为什么失败。
 *
 * 单独列出来是因为「3 条成功 1 条失败」这种结果最容易被一眼扫过去 ——
 * 而失败的那一条恰好可能就是让人连不上的那一条。
 */
export function failedOutcomes(report: AclWriteReport): AclChange[] {
  return report.outcomes
    .filter((item) => !item.ok)
    .map((item) => ({ entry: item.entry, verdict: "conflicts" as AclChangeVerdict, related: [item.message] }));
}

/** 删除时命中多条的提示：用户以为删了一条，实际可能删掉了一类。 */
export function wideDeletes(report: AclWriteReport): number {
  return report.outcomes.filter((item) => item.ok && item.matched > 1).length;
}
