/** 消费组接口，对应 `src-tauri/src/commands/consumer.rs`。 */

import { call } from "./ipc";
import type {
  BlockReport,
  ConsumerGroupDetail,
  ConsumerGroupPage,
  GroupAssignment,
  LagTrend,
} from "@/types";

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
   * 成员分区归属：每个成员负责哪些分区。
   *
   * 与详情分开：详情一打开就要看，归属只在想追问「这个分区压在谁身上」时才要。
   */
  getAssignment: (id: string, group: string) =>
    call<GroupAssignment>("get_consumer_group_assignment", { id, group }),

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
   * 删除前的预检：哪些组会被服务端拒绝、删掉会丢多少位点。
   *
   * 与删除分开成两个调用：预检给确认框看，只在弹窗打开时发；真删时再探一遍
   * 只是让用户多等一轮，而结论本来也可能已经过期。
   */
  preflightRemoval: (id: string, groups: string[]) =>
    call<GroupRemovalPreflight>("preflight_group_removal", {
      id,
      groupsToDelete: groups,
    }),

  /**
   * 删除消费组。
   *
   * 返回「删掉了谁 / 谁没删掉、为什么」：一批里删掉一部分是常态，
   * 活跃组会被服务端拒绝（NonEmptyGroup）。
   */
  deleteGroups: (id: string, groups: string[]) =>
    call<GroupRemovalOutcome>("delete_consumer_groups", { id, groupsToDelete: groups }),
};

/** 单个组的预检结论。 */
export interface GroupRemovalCheck {
  group: string;
  /** 组里还有在线成员：服务端会拒绝删除（NonEmptyGroup）。 */
  blocked: boolean;
  reason: string;
  /** 在线成员数；读不到时是 `null`，不是 0。 */
  members: number | null;
  memberDetails: {
    memberId?: string;
    clientId?: string;
    clientHost?: string;
  }[];
  /** 已提交位点的分区数：删掉之后这些进度全部消失。 */
  offsets: number;
}

/** 一次预检的总体结论。 */
export interface GroupRemovalPreflight {
  hasBlocked: boolean;
  headline: string;
  groups: GroupRemovalCheck[];
  /** 读不到状态的组及原因：这些组不参与拦截。 */
  unknown: { key: string; value: string }[];
}

/** 删除消费组的回执：部分成功是常态，所以不合成一个错误。 */
export interface GroupRemovalOutcome {
  deleted: string[];
  /** 删不掉的组及原因。 */
  failed: { key: string; value: string }[];
  detail: string;
}
