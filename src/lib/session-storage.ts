/**
 * 连接相关的本地持久化：最近使用、已保存的连接、表单草稿。
 *
 * 数据全部落在 localStorage，见 `lib/storage.ts`。密码的处理遵循「用户显式选择」：
 * 默认只记非敏感字段；用户在表单里勾选「保存连接」才把完整配置（含密码）写下来，
 * 界面上会明确提示这一点，交给使用者自行权衡。
 */

import { STORAGE_KEYS, guards, readJson, removeKey, writeJson } from "@/lib/storage";
import { connectionKey, sameConnection } from "./connection-history.ts";
import type { BrokerKind, ConnectionConfig } from "../types/broker.ts";
import { endpointOf } from "./connection-defaults.ts";
import type { SavedConnection } from "../types/connection.ts";

/** 最近使用列表的上限，超出丢弃最旧的。 */
const MAX_RECENT = 10;

/** 已保存连接的上限，防止 localStorage 被无限撑大。 */
const MAX_SAVED = 50;

export interface RecentConnection {
  name: string;
  kind: BrokerKind;
  endpoint: string;
  /** 最近使用时间（毫秒）。 */
  usedAt: number;
  /**
   * 连这一次用的配置要不要口令（Kafka 开了 SASL / RabbitMQ 带了账号）。
   *
   * 只说「要不要」，不说「是哪个账号」—— 用户名照样不落盘，这和以前一致。
   * 老记录没有这个字段：读的时候当作「要」，宁可多问一次口令，不敢替人断言不用。
   */
  noAuth?: boolean;
}

/** 已保存的连接：完整配置，可直接用来重连。 */
export type { SavedConnection } from "../types/connection.ts";

function isRecent(value: unknown): value is RecentConnection {
  if (!guards.record(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.kind === "kafka" || value.kind === "rabbitMq") &&
    typeof value.endpoint === "string" &&
    typeof value.usedAt === "number" &&
    (value.noAuth === undefined || typeof value.noAuth === "boolean")
  );
}

function isSaved(value: unknown): value is SavedConnection {
  if (!guards.record(value)) return false;
  const config = value.config;
  if (!guards.record(config)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.savedAt === "number" &&
    (config.kind === "kafka" || config.kind === "rabbitMq")
  );
}

function readRecent(): RecentConnection[] {
  return readJson(STORAGE_KEYS.recentConnections, guards.array(isRecent)) ?? [];
}

export function listRecentConnections(): RecentConnection[] {
  return readRecent().sort((a, b) => b.usedAt - a.usedAt);
}

export function rememberConnection(entry: Omit<RecentConnection, "usedAt">): void {
  const others = readRecent().filter(
    (item) => !(item.endpoint === entry.endpoint && item.kind === entry.kind),
  );
  writeJson(STORAGE_KEYS.recentConnections, [{ ...entry, usedAt: Date.now() }, ...others].slice(
    0,
    MAX_RECENT,
  ));
}

/**
 * 删掉一条「连过」的记忆。
 *
 * 判重走 `sameConnection`（地址归一后再比），和首页那张表的合并口径保持一致：
 * 界面上是同一行的那几条，删除时也得一起走，否则点一次删不掉、还要再点一次。
 */
export function forgetConnection(entry: Pick<RecentConnection, "kind" | "endpoint">): void {
  writeJson(
    STORAGE_KEYS.recentConnections,
    readRecent().filter((item) => !sameConnection(item, entry)),
  );
}

/**
 * 保存连接的标识。
 *
 * 以前是 `kind:name` —— 名字不唯一，于是两台不同地址的机器只要都叫「生产」，
 * 后存的那条就顶掉前一条（`saveConnection` 先按 id 过滤再插新的），首页那张表
 * 也就只剩一行。现在名字只用来认「这是同一条、要覆盖」，标识里带上地址。
 *
 * 覆盖的范围仍然是「同类型 + 同名 + 同地址」：改端口等于另存一条，改名字也另存一条。
 */
export function savedConnectionId(kind: BrokerKind, name: string, endpoint: string): string {
  return `${kind}:${name.trim()}@${endpoint.trim()}`;
}

function readSaved(): SavedConnection[] {
  return readJson(STORAGE_KEYS.savedConnections, guards.array(isSaved)) ?? [];
}

export function listSavedConnections(): SavedConnection[] {
  return readSaved().sort((a, b) => b.savedAt - a.savedAt);
}

/** 保存连接配置（含密码）。同类型 + 同名 + 同地址会被覆盖。 */
export function saveConnection(name: string, config: ConnectionConfig): void {
  const id = savedConnectionId(config.kind, name, endpointOf(config));
  const others = readSaved().filter((item) => item.id !== id);
  writeJson(
    STORAGE_KEYS.savedConnections,
    [{ id, name, config, savedAt: Date.now() }, ...others].slice(0, MAX_SAVED),
  );
}

/**
 * 删掉一条保存的记录。
 *
 * 按 id 精确删，不再按名字删 —— 一键删光所有记录，最常见的原因就是
 * 「删的是名字，而不是这一行」。老版本存下来的 id 是 `kind:name`（不含地址），
 * 那种记录可能不止一条同 id：所以这里顺手把同名同地址的历史 id 也一并清掉，
 * 但不同地址的同名记录一条都不碰。
 */
export function deleteSavedConnection(id: string): void {
  const target = readSaved().find((item) => item.id === id);
  writeJson(
    STORAGE_KEYS.savedConnections,
    readSaved().filter((item) => !sameRecord(item, target, id)),
  );
}

/** 这一条是不是要删的那一条：认 id，认不出 id 时退回「同类型 + 同名 + 同地址」。 */
function sameRecord(
  item: SavedConnection,
  target: SavedConnection | undefined,
  id: string,
): boolean {
  if (item.id === id) return true;
  if (!target) return false;
  return (
    item.config.kind === target.config.kind &&
    item.name === target.name &&
    connectionKey(item.config.kind, endpointOf(target.config)) ===
      connectionKey(item.config.kind, endpointOf(item.config))
  );
}

export function getSavedConnection(id: string): SavedConnection | null {
  return readSaved().find((item) => item.id === id) ?? null;
}

/** 表单草稿：按中间件分别存，切换标签页不会串。 */
export function readDraft<K extends BrokerKind>(kind: K): Extract<ConnectionConfig, { kind: K }> | null {
  const drafts = readJson(STORAGE_KEYS.connectionDrafts, guards.record) ?? {};
  const draft = drafts[kind];
  if (!guards.record(draft) || draft.kind !== kind) return null;
  return draft as unknown as Extract<ConnectionConfig, { kind: K }>;
}

export function writeDraft(config: ConnectionConfig): void {
  const drafts = readJson(STORAGE_KEYS.connectionDrafts, guards.record) ?? {};
  writeJson(STORAGE_KEYS.connectionDrafts, { ...drafts, [config.kind]: config });
}

export function clearDraft(kind: BrokerKind): void {
  const drafts = readJson(STORAGE_KEYS.connectionDrafts, guards.record) ?? {};
  delete drafts[kind];
  writeJson(STORAGE_KEYS.connectionDrafts, drafts);
}

export function clearSessionStorage(): void {
  removeKey(STORAGE_KEYS.recentConnections);
  removeKey(STORAGE_KEYS.savedConnections);
  removeKey(STORAGE_KEYS.connectionDrafts);
}
