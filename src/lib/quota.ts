/**
 * 配额与 SCRAM 凭据的判读：纯函数，不发请求。
 *
 * 后端把数据摆好了，这里只负责「该怎么读」：配额值怎么说、
 * 哪个用户会让某类客户端连不上、读不到时该说哪句话。
 * 判定口径与 `src-tauri/src/domain/quota.rs` 保持一致，改一边记得改另一边。
 */

import { QUOTA_KIND_LABEL, QUOTA_KEY_LABEL } from "../types/quota.ts";
import type {
  QuotaEntityKind,
  QuotaEntry,
  QuotaGroup,
  QuotaSnapshot,
  ScramMechanism,
  ScramSnapshot,
  ScramUser,
} from "../types/quota.ts";

/** 全部机制。Kafka 只有两种，且客户端只会用其中一种。 */
const ALL_MECHANISMS: ScramMechanism[] = ["sha256", "sha512"];

/** 字节速率的单位台阶。 */
const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** 去掉浮点数的尾巴：`10.0` 说成 `10`。 */
function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return "未知";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 字节速率：`1048576` 读成 `1.00 MB`，而不是让用户自己数零。 */
export function byteRateText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "未知";
  let scale = value;
  let unit = 0;
  while (scale >= 1024 && unit + 1 < BYTE_UNITS.length) {
    scale /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${trimNumber(scale)} B`
    : `${scale.toFixed(2)} ${BYTE_UNITS[unit]}`;
}

/**
 * 配额值的人话。
 *
 * 速率带单位、百分比带百分号、其余原样 —— 三种混在一列里时，
 * 统一加个「/s」会把 `request_percentage` 读成「每秒 75%」。
 */
export function quotaValueText(entry: QuotaEntry): string {
  switch (entry.key) {
    case "producer_byte_rate":
    case "consumer_byte_rate":
      return `${byteRateText(entry.value)}/s`;
    case "request_percentage":
      return `${trimNumber(entry.value)}%`;
    default:
      return trimNumber(entry.value);
  }
}

/** 配额键的中文名；不认识的键原样显示。 */
export function quotaKeyLabel(key: string): string {
  return QUOTA_KEY_LABEL[key] ?? key;
}

/** 实体的名字。 */
export function entityLabel(entry: QuotaEntry): string {
  const user = entry.user?.trim();
  const client = entry.clientId?.trim();
  if (user && client) return `${user} / ${client}`;
  if (user) return `${user} · 全部客户端`;
  if (client) return `客户端 ${client} · 全部用户`;
  return "集群默认";
}

/** 层级的中文名。 */
export function kindLabel(kind: QuotaEntityKind): string {
  return QUOTA_KIND_LABEL[kind];
}

/**
 * 按实体分组的视图。
 *
 * 后端已经排好序（集群默认在前），这里只做分组 —— 顺序再排一遍会让
 * 两边一旦不一致就靠「看起来对不对」来发现，不如只信一处。
 */
export function groupQuotas(entries: QuotaEntry[]): QuotaGroup[] {
  const groups: QuotaGroup[] = [];
  for (const entry of entries) {
    const label = entityLabel(entry);
    const found = groups.find((group) => group.label === label);
    if (found) {
      found.items.push(entry);
    } else {
      groups.push({
        label,
        kind: entry.kind,
        user: entry.user,
        clientId: entry.clientId,
        items: [entry],
      });
    }
  }
  return groups;
}

/**
 * 配额快照的一句话结论。
 *
 * 三种状态必须分开说：读不到 / 没有任何配额 / 有 N 个实体被限。
 * 把「读不到」说成「没有配额」是本页最容易犯的错 —— 它会让一次权限问题
 * 看起来像「集群干净得很」。
 */
export function quotaVerdict(snapshot: QuotaSnapshot): string {
  if (snapshot.error) return "读不到配额：这台集群拒绝了请求";
  if (snapshot.entries.length === 0) return "没有任何配额：所有连接都用 broker 默认值";
  const groups = groupQuotas(snapshot.entries).length;
  return `${groups} 个实体被单独限速`;
}

/** 空表时该显示的那句话（后端 notes 里已经有了，这里补一句短的做标题）。 */
export function quotaEmptyTitle(snapshot: QuotaSnapshot): string {
  if (snapshot.error) return "配额读不到";
  return "还没有配额";
}

/** 用户缺哪些机制。空数组表示两种都有。 */
export function missingMechanisms(user: ScramUser): ScramMechanism[] {
  return ALL_MECHANISMS.filter(
    (mechanism) => !user.credentials.some((item) => item.mechanism === mechanism),
  );
}

/**
 * 一个用户的凭据状况。
 *
 * 「只配了一种」是这个页面最值得说的一句话：用另一种机制连接的客户端
 * 会直接认证失败，而错误信息通常只说「认证失败」，不说是机制不对。
 */
export function scramVerdict(user: ScramUser): string {
  if (user.error) return "读取失败";
  if (user.credentials.length === 0) return "没有 SCRAM 凭据";
  const missing = missingMechanisms(user);
  if (missing.length === 0) return "两种机制都有";
  return `缺 ${missing.map(mechanismLabel).join("、")}`;
}

/** 机制的展示名。 */
export function mechanismLabel(mechanism: ScramMechanism): string {
  return mechanism === "sha256" ? "SCRAM-SHA-256" : "SCRAM-SHA-512";
}

/** 迭代次数的人话：同一种机制下两个用户的迭代次数不一致时值得警惕。 */
export function iterationsText(iterations: number): string {
  if (!Number.isFinite(iterations) || iterations <= 0) return "迭代次数未知";
  return `${iterations.toLocaleString("zh-CN")} 次`;
}

/**
 * 只配了一种机制的用户数。
 *
 * 读失败的用户不算 —— 那是「不知道」，不是「缺了一个」。
 */
export function partialUsers(snapshot: ScramSnapshot): ScramUser[] {
  return snapshot.users.filter(
    (user) => !user.error && missingMechanisms(user).length > 0,
  );
}

/**
 * SCRAM 快照的一句话结论。
 *
 * 「这台 broker 问不了」必须单独说：空表如果被读成「一个 SCRAM 用户都没有」，
 * 排查方向会整个跑偏 —— 用户会去查配置，而真正的原因是 broker 版本太老。
 */
export function scramVerdictOf(snapshot: ScramSnapshot): string {
  if (snapshot.unsupported) return "这台 broker 不支持查询 SCRAM 凭据";
  if (snapshot.users.length === 0) return "没有任何用户配了 SASL/SCRAM 凭据";
  const partial = partialUsers(snapshot).length;
  if (partial > 0) return `${snapshot.users.length} 个用户，其中 ${partial} 个只配了一种机制`;
  return `${snapshot.users.length} 个用户，两种机制都齐全`;
}

/** 快照的「可读性」：决定页面显示表格还是说明。 */
export function scramReadable(snapshot: ScramSnapshot | undefined): boolean {
  return Boolean(snapshot) && !snapshot?.unsupported;
}
