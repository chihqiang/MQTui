/**
 * 工作区现场的持久化。
 *
 * 「现场」指上次停留的连接与菜单，重启后自动回到原处——面板工具的典型用法是
 * 关掉窗口、过会儿再打开接着看。
 *
 * 这里曾经还存着一份「用户偏好」（布局 / 密度 / 字号 / 分页 / 状态条），
 * 设置弹窗撤掉之后那些开关一并归零：界面的比例由设计定，不再由 localStorage 决定。
 */

import { STORAGE_KEYS, guards, readJson, writeJson } from "@/lib/storage";
import type { BrokerCapability } from "@/types";

/** 上次停留的位置。连接 ID 是运行时生成的，重启后必然失效，只用来做优先选中。 */
export interface WorkspaceSnapshot {
  connectionId: string;
  kind: string;
  endpoint: string;
  capability: BrokerCapability;
  /** 更新时间（毫秒）。 */
  at: number;
}

interface StoredWorkspace {
  connectionId: string;
  kind: string;
  endpoint: string;
  capability: BrokerCapability;
  at: number;
}

// 列表只用于校验持久化数据，取值必须覆盖 `BrokerCapability` 的全部成员：
// 漏一个会让「从该页关闭窗口」的现场恢复直接失效。
const CAPABILITIES: BrokerCapability[] = [
  "overview",
  "topics",
  "consumerGroups",
  "orphanTopics",
  "queues",
  "exchanges",
  "consumers",
  "routing",
  "topologyGraph",
  "consumerGraph",
  "messages",
  "produce",
];

function isWorkspace(value: unknown): value is StoredWorkspace {
  if (!guards.record(value)) return false;
  return (
    typeof value.connectionId === "string" &&
    typeof value.kind === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.at === "number" &&
    CAPABILITIES.includes(value.capability as BrokerCapability)
  );
}

export function readWorkspace(): WorkspaceSnapshot | null {
  return readJson(STORAGE_KEYS.workspace, isWorkspace);
}

export function saveWorkspace(snapshot: Omit<WorkspaceSnapshot, "at">): void {
  writeJson(STORAGE_KEYS.workspace, { ...snapshot, at: Date.now() });
}

/** 最近访问的 topic / queue：key 为连接标识，值为名称列表，最新的在前。 */
const MAX_TARGETS = 8;

type TargetMap = Record<string, string[]>;

function isTargetMap(value: unknown): value is TargetMap {
  if (!guards.record(value)) return false;
  return Object.values(value).every(
    (item) => Array.isArray(item) && item.every((name) => typeof name === "string"),
  );
}

/** 连接的持久标识：运行时 ID 重启后会变，改用 kind + endpoint 聚合。 */
export function connectionMemoryKey(kind: string, endpoint: string): string {
  return `${kind}@${endpoint}`;
}

export function listRecentTargets(memoryKey: string): string[] {
  const map = readJson(STORAGE_KEYS.messageTargets, isTargetMap) ?? {};
  return map[memoryKey] ?? [];
}

export function rememberTarget(memoryKey: string, target: string): void {
  if (!memoryKey || !target) return;
  const map = readJson(STORAGE_KEYS.messageTargets, isTargetMap) ?? {};
  const others = (map[memoryKey] ?? []).filter((item) => item !== target);
  writeJson(STORAGE_KEYS.messageTargets, {
    ...map,
    [memoryKey]: [target, ...others].slice(0, MAX_TARGETS),
  });
}
