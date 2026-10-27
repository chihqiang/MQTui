/**
 * 「上次连过哪些」的聚合。
 *
 * 首页原来只认「保存过的记录」（`saved-connections`）—— 只有勾了「保存此连接」
 * 才会落盘。于是最常见的路径（连接向导里直接点「连接」，不勾保存）连成功之后
 * 什么都没留下：下次打开还是「开始使用」，用户会以为刚才那一下没记住。
 *
 * 这里把两份本地数据并成一条时间线：保存过的记录排前面（它能一键重连，
 * 含口令），没保存的只留「连过」这件事（`recent-connections` 只有名字与地址，
 * 没有口令）。界面据此在同一块地方把历史摆出来，而不是假装没有。
 */

/** 首页要展示的一条历史。`savedId` 非空表示还能直接重连。 */
export interface ConnectionHistoryItem {
  key: string;
  name: string;
  kind: string;
  endpoint: string;
  /** 保存过的记录 ID；为空表示只是连过，参数已经不在本机。 */
  savedId: string | null;
  /** 排序用：保存时间或最近连接时间。 */
  at: number;
}

/** 只取聚合需要的那几个字段，`lib` 层不依赖存储模块的具体类型。 */
export interface SavedLike {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  savedAt: number;
}

export interface RecentLike {
  name: string;
  kind: string;
  endpoint: string;
  usedAt: number;
}

/** 保存过但没口令的那类记录：口令缺口令时重连一定失败，要单独挑出来。 */
interface SavedShape {
  config: { kind: string; auth: { username?: string; password?: string } };
}

export function needsSecret(entry: SavedShape): boolean {
  const user = entry.config.auth.username?.trim();
  return Boolean(user) && !entry.config.auth.password;
}

/**
 * 合并两份历史。
 *
 * 判重按 `kind + endpoint`：反过来（按名字）会把「同一个地址改过名字」算两条。
 * 保存过的记录优先占位 —— 它才是能点得动的那一条，最近使用只补时间。
 */
export function mergeHistory(
  saved: readonly SavedLike[],
  recent: readonly RecentLike[],
): ConnectionHistoryItem[] {
  const items = new Map<string, ConnectionHistoryItem>();

  for (const entry of saved) {
    const key = `${entry.kind}@${entry.endpoint}`;
    items.set(key, {
      key,
      name: entry.name,
      kind: entry.kind,
      endpoint: entry.endpoint,
      savedId: entry.id,
      at: entry.savedAt,
    });
  }

  for (const entry of recent) {
    const key = `${entry.kind}@${entry.endpoint}`;
    const existing = items.get(key);
    if (existing) {
      // 保存过的记录名与地址以记录为准，只把时间抬到最近一次连接。
      if (entry.usedAt > existing.at) existing.at = entry.usedAt;
      continue;
    }
    // 密码只在用户勾选保存时落盘，所以「连过但没保存」的地址不展示路径里的
    // 账号片段之外的东西 —— 这里只是把「连过哪儿」说出来。
    items.set(key, {
      key,
      name: entry.name,
      kind: entry.kind,
      endpoint: entry.endpoint,
      savedId: null,
      at: entry.usedAt,
    });
  }

  // 能重连的排前面：同一条时间线上，「点一下就回得去」比「更近但回不去」有用。
  return [...items.values()].sort((a, b) => {
    if (a.savedId && !b.savedId) return -1;
    if (!a.savedId && b.savedId) return 1;
    return b.at - a.at;
  });
}

/**
 * 空态下要摆几条。
 *
 * 空态这一屏的任务是「把你上次那台接回来」，摆满十条会变成一份没有搜索的清单；
 * 三条足够覆盖「我最近在折腾的东西」，也不至于把下面的新建入口挤下去。
 */
export const HISTORY_PREVIEW = 3;

export function previewOf(items: readonly ConnectionHistoryItem[]): ConnectionHistoryItem[] {
  return items.slice(0, HISTORY_PREVIEW);
}
