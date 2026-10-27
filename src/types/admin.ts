/**
 * 与 `src-tauri/src/domain/admin.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

/** 用户标签。空标签（`none`）表示「不能登管理界面」。 */
export type UserTag =
  | "administrator"
  | "monitoring"
  | "management"
  | "policymaker"
  | "impersonator"
  | "none";

export interface UserInfo {
  name: string;
  /** 原始标签串。插件注册的未知标签原样带出来。 */
  tags: string[];
}

/** 用户在某个 vhost 上的权限。三段正则互相独立。 */
export interface PermissionInfo {
  user: string;
  vhost: string;
  configure: string;
  write: string;
  read: string;
}

export interface VhostInfo {
  name: string;
  description: string;
  /** 给 shovel / federation 用的内部 vhost。 */
  tracing: boolean;
}

/** vhost 汇总行：本体 + 队列数 + 权限数。 */
export interface VhostRow extends VhostInfo {
  queues: number;
  permissions: number;
  /** 有几条权限是全开的（三段都是 `.*`）。 */
  fullAccess: number;
}

/** 账户页的一次性快照。 */
export interface AdminSnapshot {
  vhosts: VhostRow[];
  users: UserInfo[];
  /** 受限账号读不到权限时为 `null` —— 与「没有权限记录」必须区分开。 */
  permissions: PermissionInfo[] | null;
  /** 读侧降级的原因。 */
  notes: string[];
  /** 当前连接使用的账号：删掉它等于把自己锁在门外。 */
  currentUser: string;
  currentVhost: string;
}

export interface UserSpec {
  name: string;
  /** 空串表示「不改密码」。 */
  password: string;
  tags: string[];
}

export interface UserSaveOutcome {
  users: UserInfo[];
  /** 口令太弱时的提醒，不阻断保存。 */
  passwordWarning?: string | null;
}

/** 账户页待确认的破坏性动作。三种删除共用同一个确认框。 */
export type PendingRemoval =
  | { kind: "vhost"; row: VhostRow }
  | { kind: "user"; user: UserInfo }
  | { kind: "permission"; permission: PermissionInfo };

export const USER_TAG_LABEL: Record<UserTag, string> = {
  administrator: "管理员",
  monitoring: "监控",
  management: "管理",
  policymaker: "策略",
  impersonator: "代理",
  none: "无",
};

export const USER_TAG_HINT: Record<UserTag, string> = {
  administrator: "能进管理界面，且能看所有 vhost 的资源；能改别人的密码",
  monitoring: "能进管理界面，只看指标，改不了东西",
  management: "能进管理界面，只看得到自己被授权的 vhost",
  policymaker: "能进管理界面，能改策略与参数",
  impersonator: "给 shovel / federation 用的角色，不给登录",
  none: "不能登管理界面：账号建好了、密码也对，但进不去",
};

/** 能给用户打的标签，按「最常用」排序。 */
export const ASSIGNABLE_TAGS: UserTag[] = [
  "management",
  "monitoring",
  "policymaker",
  "administrator",
];

export const VHOST_COLUMNS = [
  { key: "name", label: "名称" },
  { key: "description", label: "描述" },
  { key: "queues", label: "队列", width: "w-20", align: "right" },
  { key: "permissions", label: "权限", width: "w-20", align: "right" },
  { key: "actions", label: "操作", width: "w-32", align: "right" },
] as const;

export const USER_COLUMNS = [
  { key: "name", label: "用户名" },
  { key: "tags", label: "标签" },
  { key: "login", label: "管理界面", width: "w-24" },
  { key: "actions", label: "操作", width: "w-32", align: "right" },
] as const;

export const PERMISSION_COLUMNS = [
  { key: "user", label: "用户" },
  { key: "vhost", label: "vhost" },
  { key: "configure", label: "configure" },
  { key: "write", label: "write" },
  { key: "read", label: "read" },
  { key: "actions", label: "操作", width: "w-32", align: "right" },
] as const;

/** 三段权限的展示名。文案统一从 `lib/admin.ts` 取，这里只放常量。 */
export const PERMISSION_SEGMENTS = ["configure", "write", "read"] as const;

export type PermissionSegment = (typeof PERMISSION_SEGMENTS)[number];

/** 权限三段语义的一句话说明：编辑弹窗里逐条挂在输入框下面。 */
export const SEGMENT_HINT: Record<PermissionSegment, string> = {
  configure: "能不能声明、删除队列与交换机（只给 write/read 的话，队列只能由别人建）",
  write: "能不能往这个 vhost 里发消息",
  read: "能不能从这个 vhost 里收消息",
};
