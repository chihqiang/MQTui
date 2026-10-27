/** 与 `src-tauri/src/domain/topic_throughput.rs` 一一对应的领域类型。 */

/** 采样窗口的判定结果。 */
export type SampleWindow = "fresh" | "tooShort" | "tooOld" | "invalid";

/** 单个分区的增长率。 */
export interface PartitionRate {
  partition: number;
  /** 当前消息条数。 */
  messages: number;
  /** 窗口内写入的消息条数。 */
  delta: number;
  /** 每秒消息条数。 */
  rate: number;
}

/** 一个主题的吞吐报告。 */
export interface TopicThroughput {
  topic: string;
  /** 两次采样相隔的毫秒数。 */
  windowMs: number;
  window: SampleWindow;
  /** 当前可读消息总量。 */
  messages: number;
  /** 窗口内写入总量。 */
  delta: number;
  /** 每秒写入条数。窗口不可用时为 0。 */
  rate: number;
  /** 只含本窗口内有增长的分区，按速率倒序。 */
  partitions: PartitionRate[];
  /** 本轮已不存在的分区号（扩容前的老样本）。 */
  missing?: number[];
  /** 补充说明，可直接展示。 */
  notes?: { key: string; value: string }[];
}
