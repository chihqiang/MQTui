/**
 * 监控类页面的「一屏」布局规则。
 *
 * 集群 / 连接与通道 / 消费者这三页是仪表盘，不是列表：信息量本来就一屏装得下，
 * 却在纵向无休止地滚 —— 滚到第二屏时表头已经滚没了，对照一行数据要来回翻。
 *
 * 这里的纯函数只决定「怎么把卡片分栏、整体按什么顺序读」。
 * 真正容易做错的地方全在这儿：
 *
 * 1. **只看有问题的筛选**要把筛选前后都说出来。只剩 0 条时如果只写「没有数据」，
 *    用户以为后端挂了；写「N 条里有 0 条需要看」才知道是全绿。
 * 2. **高度未知不能写 0**。节点数拿不到上限时，进度条画成 0% 会被读成「很空」。
 * 3. **固定顺序不是保守**。仪表盘每次进来顺序都一样，眼睛才记得住位置。
 */

import { brokerTone } from "./visual.ts";

/**
 * 分栏所依据的数量：容器宽度 ÷ 单卡最小宽度，夹在 `min..max` 之间。
 *
 * 传 `containerWidth <= 0`（容器还没测量出来）时直接用最小列数：
 * 先按一列渲染、测完再改，好过先铺四列再塌成一列那种整屏跳动。
 */
export function splitColumns(
  containerWidth: number,
  minCard: number,
  max: number,
  min = 1,
): number {
  if (containerWidth <= 0 || minCard <= 0) return min;
  const fit = Math.floor(containerWidth / minCard);
  return Math.min(Math.max(fit, min), Math.max(min, max));
}

/** 一句筛选说明：两个方向都读得通，不出现「显示 0 / 共 0」。 */
export function describeScope(visible: number, total: number, unit = "条"): string {
  if (total <= 0) return "没有可显示的数据";
  if (visible === total) return `共 ${total} ${unit}`;
  return `共 ${total} ${unit} · 显示 ${visible} ${unit}`;
}

/**
 * 「只看有问题」筛选的结论。
 *
 * 三态而不是布尔：全绿、筛完为空、有内容。前两者的界面文案完全不同 ——
 * 都写「没有符合条件的项目」，用户分不清是自己筛掉了还是真的没有。
 */
export type ScopeVerdict = "empty" | "all-clear" | "filtered-out" | "has-items";

export function scopeVerdict(visible: number, total: number): ScopeVerdict {
  if (total <= 0) return "empty";
  if (visible > 0) return "has-items";
  // 有数据但一条都没显示：要么用户筛掉了，要么本来就没问题。前者给「清空筛选」，后者给「一切正常」。
  return visible === 0 && total > 0 ? "filtered-out" : "all-clear";
}

/** 把条目按列数切成若干列，按「先行后列」的顺序填充，读起来是从上到下的。 */
export function chunkColumns<T>(items: T[], columns: number): T[][] {
  const size = Math.max(columns, 1);
  const rows = Math.ceil(items.length / size);
  const out: T[][] = Array.from({ length: size }, () => []);
  items.forEach((item, index) => {
    // 按行填充：第 i 个格子落在第 i % size 列，纵向看是连续的一段。
    const column = Math.floor(index / Math.max(rows, 1));
    out[Math.min(column, size - 1)].push(item);
  });
  return out;
}

/**
 * 进度占比。
 *
 * `total <= 0` 时返回 `null` 而不是 0 —— 上限未知和「用了 0%」是两件事，
 * 画成 0% 的条子会被读成「内存很空」。调用方拿到 null 显示「未知」。
 */
export function ratio(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
  if (total <= 0) return null;
  return Math.min(Math.max(used / total, 0), 1);
}

/** 占比文案，规则同上。 */
export function ratioText(used: number, total: number): string {
  const value = ratio(used, total);
  return value === null ? "未知" : `${Math.round(value * 100)}%`;
}

/**
 * 仪表盘里卡片该按哪种「身份色」区分中间件。
 *
 * 集群页让 Kafka 与 RabbitMQ 共用同一张节点卡 —— 「谁在运行」是同一个问题，
 * 这个抽象是对的。但两个中间件的差异只留在文案里，两种连接并排打开时，
 * 卡片长得一模一样，标题上那行小字是唯一线索。
 *
 * 这里给出的是**身份色**，不是告警色：身份色必须是中性的，把 amber / rose
 * 留给 warn 与 danger，否则「这张卡是 violet」会被读成「这台节点有事」。
 */
import type { BrokerTone } from "../types/tone.ts";

export type BrokerBadgeTone = BrokerTone;


/**
 * 身份色的唯一出口在 `visual.ts`，这里只做「未知中间件不标」这一层判断。
 * 曾经这里自己写着 `kafka -> info / rabbitMq -> accent`，和 `brokerTone`
 * 各维护一份映射 —— 改一处忘一处，就会出现「连接徽标是 violet、集群页徽标是 sky」。
 */
export function brokerBadgeTone(kind: string | undefined): BrokerBadgeTone | null {
  if (!kind) return null;
  const tone = brokerTone(kind);
  return tone === "neutral" ? null : tone;
}

/** 卡片标题前的身份标签文案。`null` 表示不显示（未知中间件，别瞎标）。 */
export function brokerBadgeLabel(kind: string | undefined): string | null {
  if (!kind) return null;
  if (kind === "kafka") return "Kafka";
  if (kind === "rabbitMq" || kind === "rabbitmq") return "RabbitMQ";
  return null;
}
