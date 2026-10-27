/**
 * 「上次连过哪些」的聚合。
 *
 * 首页原来只认「保存过的记录」（`saved-connections`）—— 只有勾了「保存此连接」
 * 才会落盘。于是最常见的路径（连接向导里直接点「连接」，不勾保存）连成功之后
 * 什么都没留下：下次打开还是「开始使用」，用户会以为刚才那一下没记住。
 *
 * 这里把两份本地数据并成一条时间线。两份数据只差一件事：口令在不在本机。
 * 所以界面不在上面分两段（「已保存」/「未保存」），而是合成一张列表，
 * 只在行上标出口令在不在 —— 一条记录是不是「我的」，不该由它存过没存过来定义。
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
  /**
   * 口令在不在本机。
   *
   * 「连过」一律为 false；「保存过」要看那份配置里有没有口令 —— 用户可能只存了
   * 地址与账号。行上据此标一句「口令不在本机」，主操作也跟着换成「补口令」。
   */
  hasSecret: boolean;
  /**
   * 这一行**根本用不上**口令。
   *
   * 「没口令」和「不需要口令」是两件事，之前被压成了一件事：连一台没开 SASL 的
   * Kafka，记下来的那一刻就把它标成「口令不在本机」，点开还让你补一个不存在的口令。
   * 本机开 SASL 而留着口令，是缺；本机本来就不收口令，那是这台机器的定义。
   */
  noAuth: boolean;
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
  /** 这份配置里有没有口令；缺省按「有」算，调用方不知道时不该被判成不能重连。 */
  hasSecret?: boolean;
  /** 这份配置是否根本不用认证；缺省按「要」算，调用方不知道时不该被判成不需要。 */
  noAuth?: boolean;
}

export interface RecentLike {
  name: string;
  kind: string;
  endpoint: string;
  usedAt: number;
  /** 连这一次用的配置要不要认证。老数据没有这个字段，见 `noAuth` 的说明。 */
  noAuth?: boolean;
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

/**
 * 合并两份历史。
 *
 * 判重按 `kind + endpoint`：反过来（按名字）会把「同一个地址改过名字」算两条。
 * 保存过的记录优先占位 —— 它带着参数，最近使用只补时间。
 * 时间取两者较大的那个：保存很久之后再连一次，它仍该排在前面。
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
      hasSecret: entry.hasSecret ?? true,
      noAuth: entry.noAuth ?? false,
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
    // `recent-connections` 只有名字与地址，口令从来没落过盘。
    // 于是「缺口令」只对**要口令的那台机器**成立：连它的时候没带 SASL，
    // 就没有口令可缺 —— 之前一视同仁地标「口令不在本机」，是在替用户找一样不存在的东西。
    // 老记录没有 `noAuth` 字段，按「要认证」处理：宁可多问一次，不敢替人断言不用。
    const noAuth = entry.noAuth ?? false;
    items.set(key, {
      key,
      name: entry.name,
      kind: entry.kind,
      endpoint: entry.endpoint,
      savedId: null,
      hasSecret: noAuth,
      noAuth,
      at: entry.usedAt,
    });
  }

  // 能直接回去的排前面：时间线上「点一下就回得去」比「更近但回不去」有用。
  return [...items.values()].sort((a, b) => {
    if (canReconnect(a) && !canReconnect(b)) return -1;
    if (!canReconnect(a) && canReconnect(b)) return 1;
    return b.at - a.at;
  });
}

/**
 * 一条历史能不能直接重连。
 *
 * 有两份数据的人容易写出两份判据（首页一份、命令面板一份），于是同一条记录
 * 在一个入口说「重连」、在另一个入口说「补口令」，点了必然失败一个。
 * 这里只认一件事：要用的口令在不在本机 —— 用不上口令的机器从来就没缺过它。
 */
export function canReconnect(item: {
  savedId: string | null;
  hasSecret: boolean;
  noAuth?: boolean;
}): boolean {
  return item.savedId !== null && (item.noAuth === true || item.hasSecret);
}

/** 行上的身份标记：口令在不在本机。故意只分两种，多一档就变成需要解释的分类。 */
export type SecretState = "saved" | "missing";

export function secretStateOf(item: { hasSecret: boolean; noAuth?: boolean }): SecretState {
  return item.noAuth === true || item.hasSecret ? "saved" : "missing";
}

/** 这一行点开之后填的是「口令」还是「连接参数」。 */
export function secretLabelOf(item: { noAuth?: boolean }): string {
  return item.noAuth === true ? "重填参数" : "补口令";
}

/**
 * 空态下要摆几条。
 *
 * 空态这一屏的任务是「把你上次那台接回来」，摆满十条会变成一份没有搜索的清单；
 * 三条足够覆盖「我最近在折腾的东西」，也不至于把下面的新建入口挤下去。
 */
export const HISTORY_PREVIEW = 3;

/**
 * 一条记录都没有时，预览头三条**能重连**的。
 *
 * 一条都点不动的清单摆出来只是列个名。这里给三条真能回去的，
 * 剩下的留一句「还有 N 条」，够了。
 */
export function previewOf(items: readonly ConnectionHistoryItem[]): ConnectionHistoryItem[] {
  return items.filter(canReconnect).slice(0, HISTORY_PREVIEW);
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
