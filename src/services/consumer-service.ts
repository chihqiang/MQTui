/** 消费组接口，对应 `src-tauri/src/commands/consumer.rs`。 */

import { call } from "./ipc";
import type { BlockReport, ConsumerGroupDetail, ConsumerGroupPage, LagTrend } from "@/types";

interface ListOptions {
  connectionId: string;
  keyword?: string;
  limit?: number;
  /** 上一页返回的游标，原样回传表示「加载更多」。 */
  cursor?: string;
}

export const consumerService = {
  listConsumerGroups: ({ connectionId, keyword, limit, cursor }: ListOptions) =>
    call<ConsumerGroupPage>("list_consumer_groups", {
      id: connectionId,
      keyword,
      limit,
      cursor,
    }),

  getConsumerGroup: (id: string, group: string) =>
    call<ConsumerGroupDetail>("get_consumer_group", { id, group }),

  /**
   * 采样滞后趋势：读两次进度算差值。
   *
   * 这个调用**会等一个窗口**（默认 5 秒），所以它必须是独立命令 ——
   * 挂在详情里会把弹窗打开拖住五秒。
   */
  sampleLagTrend: (id: string, group: string, windowMs?: number) =>
    call<LagTrend>("sample_consumer_lag_trend", { id, group, windowMs }),

  /**
   * 采样队头阻塞：找「有滞后却一动不动」的分区。
   *
   * 和滞后趋势同源（都读两次），但结论完全不同：那边是积压的方向，
   * 这边是卡住的名单。所以是两个命令，不是同一份结果换个说法。
   */
  sampleBlock: (id: string, group: string, windowMs?: number) =>
    call<BlockReport>("sample_consumer_block", { id, group, windowMs }),

  /**
   * 删除消费组。
   *
   * 返回「删掉了谁 / 谁没删掉、为什么」：一批里删掉一部分是常态，
   * 活跃组会被服务端拒绝（NonEmptyGroup）。
   */
  deleteGroups: (id: string, groups: string[]) =>
    call<GroupRemovalOutcome>("delete_consumer_groups", { id, groupsToDelete: groups }),
};

/** 删除消费组的回执：部分成功是常态，所以不合成一个错误。 */
export interface GroupRemovalOutcome {
  deleted: string[];
  /** 删不掉的组及原因。 */
  failed: { key: string; value: string }[];
  detail: string;
}
