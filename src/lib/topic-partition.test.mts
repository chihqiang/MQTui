import { expect, test } from "vitest";

import {
  hasWatermarks,
  partitionMessages,
  totalMessages,
  unknownWatermarkPartitions,
} from "../types/topic.ts";
import type { TopicPartitionInfo } from "../types/topic.ts";

function part(overrides: Partial<TopicPartitionInfo> = {}): TopicPartitionInfo {
  return { partition: 0, replicas: [1], inSyncReplicas: [1], low: 0, high: 10, ...overrides };
}

/** 水位读不到：后端给的是两个 0 + 一个明确标记。 */
function blind(partition: number): TopicPartitionInfo {
  return part({ partition, low: 0, high: 0, watermarksRead: false });
}

test("读不到水位不等于 0 条", () => {
  // 回归：0 是一个结论（「这个分区空了」），读不到是「不知道」。
  // 混成同一个数字，会让人以为消息被消费光或 retention 清掉了。
  expect(partitionMessages(blind(0))).toBeUndefined();
  expect(partitionMessages(part({ low: 0, high: 10 }))).toBe(10);
  // 位点被 retention 回退时仍然是 0，不是负数。
  expect(partitionMessages(part({ low: 30, high: 10 }))).toBe(0);
});

test("缺省字段按读到了处理", () => {
  // 老数据 / 老后端不带 watermarksRead：读成「读不到」会让所有缓存变成未知。
  expect(hasWatermarks(part())).toBe(true);
  expect(hasWatermarks({ ...part(), watermarksRead: undefined })).toBe(true);
});

test("有分区读不到时总量给 undefined，而不是偏小的部分之和", () => {
  // 页头那句「N 个分区 · M 条消息」是整页唯一的汇总结论。
  // 报部分之和等于把「少算了两个分区」说成总量。
  const mixed = [part({ partition: 0, low: 0, high: 10 }), blind(1), blind(2)];
  expect(totalMessages(mixed)).toBeUndefined();
  expect(unknownWatermarkPartitions(mixed)).toEqual([1, 2]);
  expect(totalMessages([part({ partition: 0 }), part({ partition: 1, low: 5, high: 8 })])).toBe(
    13,
  );
});
