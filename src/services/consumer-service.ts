/** 消费组接口，对应 `src-tauri/src/commands/consumer.rs`。 */

import { call } from "./ipc";
import type { ConsumerGroupDetail, ConsumerGroupPage, LagTrend } from "@/types";

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
};
