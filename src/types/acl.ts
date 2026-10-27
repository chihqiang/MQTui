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
