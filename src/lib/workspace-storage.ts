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
import type { BrokerCapability } from "../types/broker.ts";

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

/*
 * 这里本来存着侧栏的折叠状态。第一层不再折叠、第二层常显之后，它没了主人：
 * 留着只会让 localStorage 里多一个永远不会被读的键，还要在每次改侧栏结构时
 * 想着它。旧数据不清理 —— 一个孤儿键比一段迁移代码便宜。
 */

/**
 * 最近用过的消费组名（按连接隔离）。
 *
 * 位点重置页是全站唯一「手敲名字代价最大」的输入框：组名打错，预览会说
 * 「没有需要改动的分区」，用户很容易读成「这个组没问题」。所以除了从服务端
 * 拉一页组名做候选，还要记住**这位用户刚刚用过的那几个** —— 它们不在第一页里
 * 也大概率是他眼下要找的那个。
 *
 * 存的是名字本身，不是 ID：组名是集群里的稳定标识，重启后依然有效。
 */
const MAX_GROUPS = 8;

type GroupMap = Record<string, string[]>;

function isGroupMap(value: unknown): value is GroupMap {
  if (!guards.record(value)) return false;
  return Object.values(value).every(
    (item) => Array.isArray(item) && item.every((name) => typeof name === "string"),
  );
}

export function listRecentGroups(memoryKey: string): string[] {
  if (!memoryKey) return [];
  const map = readJson(STORAGE_KEYS.consumerGroups, isGroupMap) ?? {};
  return map[memoryKey] ?? [];
}

export function rememberGroup(memoryKey: string, group: string): void {
  const name = group.trim();
  if (!memoryKey || !name) return;
  const map = readJson(STORAGE_KEYS.consumerGroups, isGroupMap) ?? {};
  const others = (map[memoryKey] ?? []).filter((item) => item !== name);
  writeJson(STORAGE_KEYS.consumerGroups, {
    ...map,
    [memoryKey]: [name, ...others].slice(0, MAX_GROUPS),
  });
}
