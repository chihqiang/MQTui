/** 与 `src-tauri/src/domain/orphan.rs` 一一对应的领域类型。 */

export interface OrphanPartition {
  partition: number;
  /** 分区末尾位点，即待消费消息量。 */
  high: number;
}

export interface OrphanTopic {
  topic: string;
  /** 未被任何消费组认领的分区数。 */
  partitions: number;
  /** 未被消费的消息总量。 */
  messages: number;
  detail: OrphanPartition[];
}

/**
 * 扫描范围。全量扫描要逐分区问水位，是这一页唯一的性能瓶颈，
 * 所以把范围显式交给用户：先拉候选主题列表，再只扫选中的那些。
 */
export interface OrphanScanScope {
  /** 精确指定的主题名。 */
  topics?: string[];
  /** 主题前缀，例如 `order.` 一次覆盖一批同类主题。 */
  prefix?: string;
}

export interface OrphanTopicPage {
  items: OrphanTopic[];
  total: number;
  hasMore: boolean;
  nextOffset?: number;
  /** 本次实际扫描的主题数。 */
  scannedTopics?: number;
  /** 用户点名但集群里不存在的主题。 */
  missingTopics?: string[];
}

/** 孤儿主题表的列。 */
export const ORPHAN_COLUMNS = [
  { key: "topic", label: "主题" },
  { key: "messages", label: "堆积", width: "w-28" },
  { key: "partitions", label: "未消费分区", width: "w-32" },
  { key: "actions", label: "操作", width: "w-28", align: "right" },
] as const;
