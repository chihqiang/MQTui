/**
 * 工作区现场与用户偏好的持久化。
 *
 * 「现场」指上次停留的连接与菜单，重启后自动回到原处——面板工具的典型用法是
 * 关掉窗口、过会儿再打开接着看。偏好则是纯粹的 UI 设置。
 */

import { DEFAULT_LAYOUT, isLayoutMode, type LayoutMode } from "@/lib/layout";
import { DEFAULT_DENSITY, isDensity, type Density } from "@/lib/list-view";
import { STORAGE_KEYS, guards, readJson, writeJson } from "@/lib/storage";
import {
  DEFAULT_META_SCALE,
  DEFAULT_STATUS_DENSITY,
  isMetaScale,
  isStatusDensity,
  type MetaScale,
  type StatusDensity,
} from "@/lib/visual";
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

/** 用户偏好。新增字段时给默认值即可，老数据缺字段不会崩。 */
export interface Preferences {
  /**
   * 左侧连接列表是否折叠。
   *
   * 早期版本只有这一个开关；现在布局由 `layout` 统管，这里仅作为
   * 「极简」档的落盘结果保留，读偏好时与 `layout` 互相兜底。
   */
  sidebarCollapsed: boolean;
  /** 外壳布局形态：分组 / 平铺 / 极简。 */
  layout: LayoutMode;
  /** 消息列表单页条数偏好。 */
  pageSize: number;
  /** 表格行密度：全站一致，翻页面时视线不用重新适应。 */
  density: Density;
  /** 次级字号档（11 / 12px）。默认 11，拨到 12 是「我眼睛想轻松点」。 */
  metaScale: MetaScale;
  /** 顶部状态条（健康条）的厚度。 */
  statusDensity: StatusDensity;
}

export const DEFAULT_PREFERENCES: Preferences = {
  sidebarCollapsed: false,
  layout: DEFAULT_LAYOUT,
  pageSize: 100,
  density: DEFAULT_DENSITY,
  metaScale: DEFAULT_META_SCALE,
  statusDensity: DEFAULT_STATUS_DENSITY,
};

/**
 * 老数据缺字段时逐项回落到默认值，而不是整份丢弃。
 *
 * 之前是「形状不对就当没存过」，于是加一个新偏好就会把用户已经调好的
 * 侧边栏状态一起清掉 —— 一个可选字段不该有这种权力。
 */
function isPreferences(value: unknown): value is Preferences {
  if (!guards.record(value)) return false;
  return (
    typeof value.sidebarCollapsed === "boolean" &&
    typeof value.pageSize === "number" &&
    value.pageSize > 0 &&
    // 早期版本没有 `density` / `layout` / `metaScale` / `statusDensity`，
    // 缺字段一律视为合法：新版偏好是向后兼容的加法。
    (value.density === undefined || isDensity(value.density)) &&
    (value.layout === undefined || isLayoutMode(value.layout)) &&
    (value.metaScale === undefined || isMetaScale(value.metaScale)) &&
    (value.statusDensity === undefined || isStatusDensity(value.statusDensity))
  );
}

export function readPreferences(): Preferences {
  const stored = readJson(STORAGE_KEYS.preferences, isPreferences);
  // 按字段补齐而不是整份覆盖：缺 `density` 的老数据不该把侧边栏状态一起重置。
  if (!stored) return DEFAULT_PREFERENCES;
  // 老数据只有 `sidebarCollapsed`：它等价于「极简 / 非极简」两档。
  // 不这么兜底的话，升级后所有收起过侧边栏的用户会突然看到一列菜单重新展开。
  const layout = stored.layout ?? (stored.sidebarCollapsed ? "collapsed" : DEFAULT_LAYOUT);
  return { ...DEFAULT_PREFERENCES, ...stored, layout, sidebarCollapsed: layout === "collapsed" };
}

export function savePreferences(next: Preferences): void {
  writeJson(STORAGE_KEYS.preferences, next);
}
