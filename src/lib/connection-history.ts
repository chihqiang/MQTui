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
  /** 名字；后端在用户没填时按地址回填的那个名字已经去掉，见 `displayName`。 */
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

/**
 * 这个名字是不是「没起过，被自动填上的」。
 *
 * 两种来源：
 *
 * - 向导里选了类型却没填名字 —— 名字被回填成中间件本身（`defaultName()`），
 *   首页那一行于是读作「Kafka · Kafka」，一个字说了两遍；
 * - 更老的记录里名字就是地址的主机段（`127.0.0.1 · 127.0.0.1:9092`），
 *   上半截和下半截是同一件事。
 *
 * 只认这两种形态，不猜别的：名字叫 `prod-kafka` 而地址是 `10.0.0.1:9092`，
 * 那明显是起过的名字。反过来，名字 `kafka-prod` 与地址 `kafka-prod:9092`
 * 一模一样时没法区分是谁写的 —— 宁可多留一个名字，也不要抹掉人起的那一个。
 * `labels` 是中间件的显示名清单。
 */
export function isAutomaticName(name: string, endpoint: string, labels: readonly string[] = []): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (labels.some((label) => label.toLowerCase() === trimmed.toLowerCase())) return true;
  const first = endpoint.split(",")[0]?.trim() ?? "";
  const host = first.replace(/:[^:]*$/, "");
  // 只看得出「这是台 IP / 本机」的地址才认：`127.0.0.1`、`localhost` 这类不会是名字。
  return isAddressLike(host) && trimmed === host;
}

/** 主机段是不是一个「看得出是地址」的值。 */
function isAddressLike(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "localhost" || host === "::1";
}

/** 行上该写什么名字：自动填上的名字去掉，地址那一行已经说明是哪台机器。 */
export function displayName(
  item: { name: string; endpoint: string },
  labels: readonly string[] = [],
): string {
  return isAutomaticName(item.name, item.endpoint, labels) ? "" : item.name.trim();
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

/**
 * 空态里只预览三条**能重连**的。
 *
 * 「连过 · 未保存」那几条点进去先要补口令，属于「还有一台机器」，
 * 不该把真正一点就回去的记录挤出屏幕。三条都没有时预览就是空的。
 */
export function previewOf(items: readonly ConnectionHistoryItem[]): ConnectionHistoryItem[] {
  return items.filter((item) => item.savedId !== null).slice(0, HISTORY_PREVIEW);
}

/**
 * 「连过但没保存」那一行点「连接」时，该去敲哪个口。
 *
 * 历史里存的是 `host:port`，能取到就用它 —— 用户当初连的是 5673，就还敲 5673。
 * 取不到时按中间件的默认端口兜：RabbitMQ 5672 是 AMQP 的口（15672 只给管理界面，
 * 敲它连不上），Kafka 9092。
 */
export function brokerPortFor(kind: string, endpoint: string): number {
  const port = Number(endpoint.split(",")[0]?.trim().split(":").pop());
  if (Number.isInteger(port) && port > 0) return port;
  return kind === "rabbitMq" ? 5672 : 9092;
}
