/**
 * localStorage 的统一出口。
 *
 * 项目里所有需要持久化的数据都放在 localStorage（不引入 SQLite / 钥匙串），
 * 集中到这里有三个好处：
 * 1. key 带统一前缀，导出/清空时不会误伤同源的其他数据；
 * 2. 读写都包在 try/catch 里 —— 隐私模式、配额写满时 localStorage 会抛异常，
 *    不能让一个存储故障把整个应用打挂；
 * 3. 读取时做一次形状校验，存储里的脏数据直接当作「没存过」。
 */

/** 所有 key 的统一前缀，改这里等于换命名空间。 */
const PREFIX = "mqtui";

/** 业务 key 清单：一个 key 只属于一个模块，避免多处读写同一块数据。 */
export const STORAGE_KEYS = {
  /** 最近使用过的连接（不含密码）。 */
  recentConnections: "recent-connections",
  /** 已保存的连接配置，含密码，用户显式保存才有。 */
  savedConnections: "saved-connections",
  /** 按中间件分类的连接表单草稿。 */
  connectionDrafts: "connection-drafts",
  /** 上次停留的工作区位置，用于重启后恢复现场。 */
  workspace: "workspace",
  /** 最近访问过的 topic / queue，按连接隔离。 */
  messageTargets: "message-targets",
  /** 最近用过的消费组名，按连接隔离：位点重置的唯一手输项。 */
  consumerGroups: "consumer-groups",
  /** 侧栏里被手动折起来的组（中间件 / 当前连接的页面菜单）。 */
  collapsedGroups: "collapsed-groups",
} as const;

function fullKey(key: string): string {
  return `${PREFIX}.${key}`;
}

/**
 * 读取并解析，解析失败或形状不符时返回 `null`。
 *
 * @param key 业务 key（不含前缀）
 * @param guard 形状校验，用于挡掉历史版本遗留的脏数据
 */
export function readJson<T>(key: string, guard: (value: unknown) => value is T): T | null {
  try {
    const raw = localStorage.getItem(fullKey(key));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写入，失败（配额满 / 无痕模式）时忽略，不影响交互。 */
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(fullKey(key), JSON.stringify(value));
  } catch {
    // 存储不可用时降级为「本次会话不持久化」，属于可接受的产品行为。
  }
}

/** 删除单个 key。 */
export function removeKey(key: string): void {
  try {
    localStorage.removeItem(fullKey(key));
  } catch {
    // 同上，静默降级。
  }
}

/** 清空本应用写入的全部数据，用于设置页的「重置」。 */
export function clearAll(): void {
  for (const key of Object.values(STORAGE_KEYS)) {
    removeKey(key);
  }
}

/** 导出全部数据，便于用户备份或排障时回传。 */
export function exportAll(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.values(STORAGE_KEYS)) {
    try {
      const raw = localStorage.getItem(fullKey(key));
      if (raw !== null) snapshot[key] = JSON.parse(raw) as unknown;
    } catch {
      // 单个 key 坏掉不影响导出其他数据。
    }
  }
  return snapshot;
}

/** 常用形状校验器。 */
export const guards = {
  array: <T>(item: (value: unknown) => value is T) =>
    (value: unknown): value is T[] => Array.isArray(value) && value.every(item),
  record: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  string: (value: unknown): value is string => typeof value === "string",
};
