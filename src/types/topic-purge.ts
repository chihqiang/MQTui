/** 与 `src-tauri/src/domain/topic_purge.rs` 一一对应的领域类型。 */

import type { KeyValue } from "./broker.ts";

/** 主题级写操作。 */
export type PurgeKind = "truncate" | "deleteBefore";

/** 一次写操作的请求。 */
export interface PurgeRequest {
  topic: string;
  kind: PurgeKind;
  /** 按时间删记录时的截止时间戳（毫秒）。`truncate` 忽略。 */
  before?: number;
  /** 只处理这些分区；空数组表示全部。 */
  partitions: number[];
}

/** 单个分区的处理计划。 */
export interface PurgePartitionPlan {
  partition: number;
  currentLow: number;
  currentHigh: number;
  /** 计划推到的新低位点。 */
  targetLow: number;
}

/** 写操作计划：`blocked` 非空表示不能提交。 */
export interface PurgePlan {
  topic: string;
  kind: PurgeKind;
  partitions: PurgePartitionPlan[];
  /** 会消失的消息总条数。 */
  removed: number;
  /** 按时间边界查不到、被跳过的分区。 */
  unresolved?: number[];
  blocked?: string;
  /** 提交前必须让用户知道的事实。 */
  notes: string[];
}

export interface PurgeOutcome {
  topic: string;
  /** 真正提交了删除动作的分区。 */
  partitions: number[];
  removed: number;
  detail: string;
  /** 服务端对个别分区报的错：部分成功是常态。 */
  failed?: KeyValue[];
}

/** 写操作类型的展示文案与表单提示。 */
export const PURGE_KIND_OPTIONS: {
  value: PurgeKind;
  label: string;
  hint: string;
}[] = [
  {
    value: "truncate",
    label: "清空全部分区",
    hint: "把每个分区的可读起点推到末尾：消息立刻读不到，磁盘等 retention 才回收",
  },
  {
    value: "deleteBefore",
    label: "删除某个时间之前的消息",
    hint: "只删早于截止时间的消息；边界由服务端按时间戳反查，分区之间可能差一两条",
  },
];
