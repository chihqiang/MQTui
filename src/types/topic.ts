/** 与 `src-tauri/src/domain/topic.rs` 一一对应的领域类型。 */

/** 单个分区的布局：副本分布 + 水位。 */
export interface TopicPartitionInfo {
  partition: number;
  /** 当前 leader；集群选主期间可能缺失。 */
  leader?: number;
  /** 全部副本所在节点，顺序即副本顺序。 */
  replicas: number[];
  /** 已同步副本。比 `replicas` 少说明有副本掉队。 */
  inSyncReplicas: number[];
  /** 起始位点。 */
  low: number;
  /** 末尾位点。 */
  high: number;
  /**
   * 水位读到了没有。
   *
   * 读不到时 `low` / `high` 都是 0，`high - low` 也恰好是 0 ——
   * 「权限不足 / leader 迁移中」和「这个分区是空的」看起来一模一样。
   * 缺省按 `true` 处理（后端老数据不带这个字段）。
   */
  watermarksRead?: boolean;
}

/** 这个分区的水位读到了没有。缺省视为读到了。 */
export function hasWatermarks(partition: TopicPartitionInfo): boolean {
  return partition.watermarksRead !== false;
}

/** 该分区可读条数；水位读不到时是 `undefined`，不是 0。 */
export function partitionMessages(partition: TopicPartitionInfo): number | undefined {
  if (!hasWatermarks(partition)) return undefined;
  return Math.max(partition.high - partition.low, 0);
}

/**
 * 主题消息总量；有分区水位读不到时是 `undefined`。
 *
 * 不给「部分之和」：那是把「少算了几个分区」当成总量报出去，
 * 而读这个数的人正是拿它判断主题还剩多少消息。
 */
export function totalMessages(partitions: TopicPartitionInfo[]): number | undefined {
  let total = 0;
  for (const partition of partitions) {
    const messages = partitionMessages(partition);
    if (messages === undefined) return undefined;
    total += messages;
  }
  return total;
}

/** 水位读不到的分区号，用于在页头点名。 */
export function unknownWatermarkPartitions(partitions: TopicPartitionInfo[]): number[] {
  return partitions.filter((item) => !hasWatermarks(item)).map((item) => item.partition);
}

export interface TopicDetail {
  name: string;
  partitions: TopicPartitionInfo[];
  /** 非默认配置项（默认值不返回，避免几百行的表把重点埋掉）。 */
  configs?: { key: string; value: string }[];
  /** 内部主题（`__` 前缀），不可删/扩容。 */
  internal: boolean;
}

/** 新建主题请求，字段与后端 `TopicSpec` 对应。 */
export interface TopicSpec {
  name: string;
  partitions: number;
  /** 0 表示使用服务端默认副本因子。 */
  replicationFactor: number;
  configs?: { key: string; value: string }[];
}

/** 分区扩容请求。 */
export interface PartitionExpansion {
  topic: string;
  partitions: number;
}

/** 主题运维能力：界面据此启停按钮，不重复实现后端的规则。 */
export interface TopicCapabilities {
  canCreate: boolean;
  canDelete: boolean;
  canExpand: boolean;
  /** 不能操作的原因，`key` 是 delete / expand。 */
  reasons?: { key: string; value: string }[];
}

/** 单个主题的分区分布（与 `domain/partition_hotspot.rs` 对应）。 */
export interface PartitionSpread {
  topic: string;
  /** 分区总数。 */
  partitions: number;
  /** 全部消息总量。 */
  messages: number;
  /** 最热分区的消息数。 */
  maxMessages: number;
  /** 最热分区号；全空主题没有。 */
  hottest?: number;
  /** 空分区数量。只数读得到、且确实为 0 的分区。 */
  empty: number;
  /**
   * 水位读不到的分区号。
   *
   * 它们既不算空分区也不参与「最热」判定 —— 「读不到」和「是空的」是两件事，
   * 混成一个 0 会把用户带去调 key 分布。
   */
  unavailable?: number[];
  /** 是否判定为热点（少数分区扛住绝大部分流量）。 */
  hotspot: boolean;
  /** 判定说明。 */
  note?: string;
}

/** 分区热点分析结果。 */
export interface HotspotReport {
  /** 全部分析过的主题，按主题名排序。 */
  topics: PartitionSpread[];
  /** 仅热点主题，按偏离均分的程度倒序。 */
  hotspots: PartitionSpread[];
  /** 点名却不存在的主题。 */
  missing: string[];
}

export interface TopicOutcome {
  kind: string;
  topic: string;
  detail: string;
}

/** 主题表的列：宽度与对齐只写一次，骨架屏与真实行共用。 */
export const TOPIC_COLUMNS = [
  { key: "select", label: "", width: "w-8" },
  { key: "name", label: "名称" },
  { key: "partitions", label: "分区", width: "w-16", align: "right" },
  { key: "replication", label: "副本", width: "w-16", align: "right" },
  { key: "actions", label: "操作", width: "w-28", align: "right" },
] as const;

/**
 * 分区表的列。
 *
 * 「副本」与「已同步副本」并排两列是刻意的：排查「写不进去」时第一眼看的是
 * 有没有副本掉队，两串数字分开摆，靠肉眼比长度很容易漏。
 */
export const PARTITION_COLUMNS = [
  { key: "partition", label: "分区", width: "w-16", align: "right" },
  { key: "leader", label: "Leader", width: "w-24", align: "right" },
  { key: "replicas", label: "副本" },
  { key: "isr", label: "已同步" },
  { key: "low", label: "起始位点", width: "w-28", align: "right" },
  { key: "high", label: "末尾位点", width: "w-28", align: "right" },
  { key: "messages", label: "消息数", width: "w-28", align: "right" },
  { key: "actions", label: "操作", width: "w-24", align: "right" },
] as const;
