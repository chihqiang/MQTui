/**
 * 与 `src-tauri/src/domain/acl.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

/** ACL 资源类型。事务 ID 等少见类型不在面板范围内。 */
export type AclResourceType = "topic" | "group" | "cluster" | "broker";

/** 规则里的操作。`all` 会覆盖其余全部操作。 */
export type AclOperation =
  | "all"
  | "read"
  | "write"
  | "create"
  | "delete"
  | "alter"
  | "describe"
  | "describeConfigs"
  | "alterConfigs"
  | "clusterAction"
  | "idempotentWrite";

/**
 * 允许还是拒绝。
 *
 * 同一个主体对同一个资源同时有两者时，以 `deny` 为准。
 */
export type AclPermission = "allow" | "deny";

/** 名字怎么匹配。`wildcard` 是 Kafka 的「精确匹配 + 名字 `*`」，这里拆开表示。 */
export type AclPattern = "literal" | "prefixed" | "wildcard";

/** 一条 ACL 规则。 */
export interface AclEntry {
  resourceType: AclResourceType;
  /** `prefixed` 时是前缀、`wildcard` 时为空串。 */
  resourceName: string;
  pattern: AclPattern;
  /** 形如 `User:alice`。 */
  principal: string;
  /** 来源主机，`*` 表示不限。 */
  host: string;
  operation: AclOperation;
  permission: AclPermission;
}

/**
 * ACL 快照。
 *
 * `unsupported` 有值表示这台 broker 压根不会回答这个问题 —— 那与
 * 「没有任何 ACL」是两个完全不同的结论，不能拿空表糊过去。
 */
export interface AclSnapshot {
  entries: AclEntry[];
  unsupported?: string;
  notes: string[];
}

/** 一个主体的全部规则。 */
export interface PrincipalAcl {
  principal: string;
  entries: AclEntry[];
}

/**
 * 过滤器。字段缺席 = 这一项不筛。
 *
 * 空串与缺席不同：`resourceName: ""` 是「名字为空串的资源」（Kafka 用它表示通配），
 * 不是「不过滤」。
 */
export interface AclFilter {
  resourceType?: AclResourceType;
  resourceName?: string;
  principal?: string;
  operation?: AclOperation;
  permission?: AclPermission;
}

/** 资源类型的中文名。 */
export const ACL_RESOURCE_LABEL: Record<AclResourceType, string> = {
  topic: "主题",
  group: "消费组",
  cluster: "集群",
  broker: "Broker",
};

/** 操作的中文名。 */
export const ACL_OPERATION_LABEL: Record<AclOperation, string> = {
  all: "全部",
  read: "读",
  write: "写",
  create: "建",
  delete: "删",
  alter: "改",
  describe: "查",
  describeConfigs: "读配置",
  alterConfigs: "改配置",
  clusterAction: "集群动作",
  idempotentWrite: "幂等写",
};

/** 权限的中文名。 */
export const ACL_PERMISSION_LABEL: Record<AclPermission, string> = {
  allow: "允许",
  deny: "拒绝",
};

/** 匹配方式的中文名。 */
export const ACL_PATTERN_LABEL: Record<AclPattern, string> = {
  literal: "精确匹配",
  prefixed: "前缀匹配",
  wildcard: "全部资源",
};

/** 规则表的列。 */
export const ACL_COLUMNS = [
  { key: "principal", label: "主体" },
  { key: "principal", label: "主体" },
  { key: "resource", label: "资源" },
  { key: "operation", label: "操作", width: "w-28" },
  { key: "permission", label: "权限", width: "w-24" },
  { key: "host", label: "来源主机", width: "w-36" },
] as const;

/** 按主体分组的列：组头是一行主体名，里面是这个人能做的事。 */
export const ACL_PRINCIPAL_COLUMNS = [
  { key: "principal", label: "主体" },
  { key: "resource", label: "资源" },
  { key: "operation", label: "操作", width: "w-28" },
  { key: "permission", label: "权限", width: "w-24" },
  { key: "host", label: "来源主机", width: "w-36" },
] as const;

/** 资源类型下拉的选项顺序：先常看的主题 / 消费组，再集群级。 */
export const ACL_RESOURCE_OPTIONS: { value: AclResourceType; label: string }[] = [
  { value: "topic", label: "主题" },
  { value: "group", label: "消费组" },
  { value: "cluster", label: "集群" },
  { value: "broker", label: "Broker" },
];

/**
 * 一条待提交规则的处境。与 `src-tauri/src/domain/acl.rs` 的 `AclChangeVerdict` 一一对应。
 *
 * 只区分这四种：新增、已经在了、与现有规则冲突、被现有规则覆盖。
 * 「提交成功」不属于这里 —— 那是提交之后的回执。
 */
export type AclChangeVerdict = "new" | "exists" | "conflicts" | "superseded";

/** 一条待提交的规则，以及它在现有规则里的处境。 */
export interface AclChange {
  entry: AclEntry;
  verdict: AclChangeVerdict;
  /** 冲突 / 覆盖时必须指出来是哪几条在相干，否则用户没法判断。 */
  related: string[];
}

/** 一次写入的完整预演。 */
export interface AclChangePlan {
  changes: AclChange[];
  /** 会真正改变集群的条数。 */
  effective: number;
  /** 提交前必须让人看见的风险（自锁、`User:*`、只有拒绝没有允许）。 */
  blockers: string[];
  notes: string[];
}

/** 写入请求。`confirm` 是用户手打的主体名，预演时留空。 */
export interface AclWriteRequest {
  entries: AclEntry[];
  confirm: string;
}

/** 单条规则的执行结果。 */
export interface AclWriteOutcome {
  entry: AclEntry;
  ok: boolean;
  message: string;
  /** 删除时实际命中的条数：`0` 说明这条本来就不在集群上。 */
  matched: number;
}

/** 一次写入的执行回执。 */
export interface AclWriteReport {
  outcomes: AclWriteOutcome[];
  applied: number;
  notes: string[];
}
