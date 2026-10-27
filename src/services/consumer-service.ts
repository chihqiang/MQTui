/** 消费组接口，对应 `src-tauri/src/commands/consumer.rs`。 */

import { call } from "./ipc";
import type { ConsumerGroupDetail, ConsumerGroupPage } from "@/types";

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
};
