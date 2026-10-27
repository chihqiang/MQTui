/**
 * 连接相关的本地持久化：最近使用、已保存的连接、表单草稿。
 *
 * 数据全部落在 localStorage，见 `lib/storage.ts`。密码的处理遵循「用户显式选择」：
 * 默认只记非敏感字段；用户在表单里勾选「保存连接」才把完整配置（含密码）写下来，
 * 界面上会明确提示这一点，交给使用者自行权衡。
 */

import { STORAGE_KEYS, guards, readJson, removeKey, writeJson } from "@/lib/storage";
import type { BrokerKind, ConnectionConfig } from "@/types";

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
}

/** 已保存的连接：完整配置，可直接用来重连。 */
export interface SavedConnection {
  /** 稳定标识，由 kind + name 派生，同名同类型视为同一条。 */
  id: string;
  name: string;
  config: ConnectionConfig;
  /** 保存时间（毫秒）。 */
  savedAt: number;
}

function isRecent(value: unknown): value is RecentConnection {
  if (!guards.record(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.kind === "kafka" || value.kind === "rabbitMq") &&
    typeof value.endpoint === "string" &&
    typeof value.usedAt === "number"
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

export function forgetConnection(entry: Pick<RecentConnection, "kind" | "endpoint">): void {
  writeJson(
    STORAGE_KEYS.recentConnections,
    readRecent().filter(
      (item) => !(item.endpoint === entry.endpoint && item.kind === entry.kind),
    ),
  );
}

/** 保存连接的标识规则：同类型同名即覆盖，改名等于另存。 */
export function savedConnectionId(kind: BrokerKind, name: string): string {
  return `${kind}:${name.trim()}`;
}

function readSaved(): SavedConnection[] {
  return readJson(STORAGE_KEYS.savedConnections, guards.array(isSaved)) ?? [];
}

export function listSavedConnections(): SavedConnection[] {
  return readSaved().sort((a, b) => b.savedAt - a.savedAt);
}

/** 保存连接配置（含密码）。同名同类型会被覆盖。 */
export function saveConnection(name: string, config: ConnectionConfig): void {
  const id = savedConnectionId(config.kind, name);
  const others = readSaved().filter((item) => item.id !== id);
  writeJson(
    STORAGE_KEYS.savedConnections,
    [{ id, name, config, savedAt: Date.now() }, ...others].slice(0, MAX_SAVED),
  );
}

export function deleteSavedConnection(id: string): void {
  writeJson(
    STORAGE_KEYS.savedConnections,
    readSaved().filter((item) => item.id !== id),
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
