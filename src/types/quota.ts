/**
 * 与 `src-tauri/src/domain/quota.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

/** 配额实体的层级。缺省一半的实体读法完全不同，所以层级要显式带出来。 */
export type QuotaEntityKind = "user" | "clientId" | "userClientId" | "default";

/** 一条配额记录：谁、哪一项、多少。 */
export interface QuotaEntry {
  user?: string;
  clientId?: string;
  kind: QuotaEntityKind;
  key: string;
  value: number;
}

/** 一个实体下的全部配额项（后端 `groups()` 的输出）。 */
export interface QuotaGroup {
  label: string;
  kind: QuotaEntityKind;
  user?: string;
  clientId?: string;
  items: QuotaEntry[];
}

/** 配额快照。`error` 有值时不是「没有配额」，而是「读不到」。 */
export interface QuotaSnapshot {
  entries: QuotaEntry[];
  error?: string;
  notes: string[];
}

/** SASL/SCRAM 机制。Kafka 只有这两种。 */
export type ScramMechanism = "sha256" | "sha512";

export interface ScramCredential {
  mechanism: ScramMechanism;
  /** 迭代次数：改它会让已发出的客户端配置失效。 */
  iterations: number;
}

/** 一个用户的凭据。`error` 有值时 `credentials` 必然是空的。 */
export interface ScramUser {
  user: string;
  credentials: ScramCredential[];
  error?: string;
}

/** SCRAM 快照。`unsupported` 有值表示这台 broker 压根不会回答这个问题。 */
export interface ScramSnapshot {
  users: ScramUser[];
  unsupported?: string;
  notes: string[];
}

/** 层级的中文名。 */
export const QUOTA_KIND_LABEL: Record<QuotaEntityKind, string> = {
  user: "用户",
  clientId: "客户端",
  userClientId: "用户 + 客户端",
  default: "集群默认",
};

/** 机制的展示名。 */
export const SCRAM_MECHANISM_LABEL: Record<ScramMechanism, string> = {
  sha256: "SCRAM-SHA-256",
  sha512: "SCRAM-SHA-512",
};

/** 常见配额键的中文名；不认识的键原样显示，不编名字。 */
export const QUOTA_KEY_LABEL: Record<string, string> = {
  producer_byte_rate: "生产者速率",
  consumer_byte_rate: "消费者速率",
  request_percentage: "请求占用",
  controller_mutation_rate: "控制器变更速率",
};

/** 配额表的列。 */
export const QUOTA_COLUMNS = [
  { key: "entity", label: "实体" },
  { key: "kind", label: "层级", width: "w-32" },
  { key: "key", label: "配额项", width: "w-40" },
  { key: "value", label: "额度", width: "w-32", align: "right" as const },
] as const;

/** SCRAM 凭据表的列。 */
export const SCRAM_COLUMNS = [
  { key: "user", label: "用户" },
  { key: "sha256", label: "SCRAM-SHA-256", width: "w-40" },
  { key: "sha512", label: "SCRAM-SHA-512", width: "w-40" },
  { key: "verdict", label: "结论", width: "w-44" },
] as const;
