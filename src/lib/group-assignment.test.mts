import { expect, test } from "vitest";

import {
  assignmentVerdict,
  memberAssignmentText,
  memberAssignmentTone,
  ownersByPartition,
  partitionLabel,
  partitionsText,
  unownedPartitions,
  unownedText,
} from "./group-assignment.ts";
import type {
  GroupAssignment,
  MemberAssignment,
} from "../types/group-assignment.ts";
import type { ConsumerGroupOffset } from "../types/consumer.ts";

function member(patch: Partial<MemberAssignment> = {}): MemberAssignment {
  return {
    memberId: "worker-1",
    partitions: [],
    state: "assigned",
    ...patch,
  };
}

function assignment(patch: Partial<GroupAssignment> = {}): GroupAssignment {
  return { byMember: [], ...patch };
}

function offset(
  topic: string,
  partition: number,
  lag = 0,
): ConsumerGroupOffset {
  return { topic, partition, high: 100, lag };
}

test("分区标签带 P 前缀，和滞后表的写法对上", () => {
  expect(partitionLabel({ topic: "orders", partition: 3 })).toBe("orders-P3");
});

test("分区多时只列前几个，但总数要说出来", () => {
  const partitions = Array.from({ length: 8 }, (_, index) => ({
    topic: "orders",
    partition: index,
  }));
  const text = partitionsText(partitions, 3);
  expect(text).toContain("orders-P0");
  expect(text).toContain("等 8 个");
});

test("三种「没有分区」分开说", () => {
  expect(memberAssignmentText(member({ state: "broken" }))).toBe(
    "归属未知（分配读不懂）",
  );
  expect(memberAssignmentText(member({ state: "empty" }))).toBe("暂未分到分区");
  // 读不懂要看得见，暂未分到是常态。
  expect(memberAssignmentTone(member({ state: "broken" }))).toBe("warning");
  expect(memberAssignmentTone(member({ state: "empty" }))).toBe("neutral");
  expect(memberAssignmentTone(member())).toBe("success");
});

test("分区 → 成员翻转按名字与分区号排序", () => {
  const owners = ownersByPartition(
    assignment({
      byMember: [
        member({
          memberId: "b",
          partitions: [
            { topic: "payments", partition: 1 },
            { topic: "orders", partition: 2 },
          ],
        }),
        member({
          memberId: "a",
          partitions: [{ topic: "orders", partition: 10 }],
        }),
      ],
    }),
  );
  expect(owners.map((item) => `${item.topic}-P${item.partition}`)).toEqual([
    "orders-P2",
    "orders-P10",
    "payments-P1",
  ]);
});

test("重复归属时同一个分区记两个成员", () => {
  const owners = ownersByPartition(
    assignment({
      byMember: [
        member({
          memberId: "a",
          partitions: [{ topic: "orders", partition: 1 }],
        }),
        member({
          memberId: "b",
          partitions: [{ topic: "orders", partition: 1 }],
        }),
      ],
    }),
  );
  expect(owners).toHaveLength(1);
  expect(owners[0].owners).toEqual(["a", "b"]);
});

test("无主分区只看组提交过位点的那些", () => {
  const result = unownedPartitions(
    assignment({
      byMember: [member({ partitions: [{ topic: "orders", partition: 0 }] })],
    }),
    [offset("orders", 0), offset("orders", 1), offset("payments", 0)],
  );
  expect(result.map((item) => `${item.topic}-P${item.partition}`)).toEqual([
    "orders-P1",
    "payments-P0",
  ]);
});

test("没有归属数据时不给结论", () => {
  expect(assignmentVerdict(undefined, [])).toBeUndefined();
});

test("协议不适用时只说一句，不报警", () => {
  const verdict = assignmentVerdict(
    assignment({
      notes: [
        "协议类型是 connect，不是消费者协议 —— 这类组没有「分区归属」这回事",
      ],
    }),
    [],
  );
  expect(verdict?.tone).toBe("neutral");
  expect(verdict?.text).toContain("connect");
});

test("读不懂的成员优先报出来", () => {
  const verdict = assignmentVerdict(
    assignment({
      byMember: [
        member({ memberId: "a", state: "broken" }),
        member({
          memberId: "b",
          partitions: [{ topic: "orders", partition: 0 }],
        }),
      ],
    }),
    [offset("orders", 1)],
  );
  expect(verdict?.tone).toBe("warning");
  expect(verdict?.text).toContain("读不懂");
});

test("全部覆盖时说清楚，别让人继续猜", () => {
  const verdict = assignmentVerdict(
    assignment({
      byMember: [member({ partitions: [{ topic: "orders", partition: 0 }] })],
    }),
    [offset("orders", 0)],
  );
  expect(verdict?.tone).toBe("success");
});

test("无主分区说明里带上名字，只说数量等于没说", () => {
  const text = unownedText([offset("orders", 1), offset("payments", 0)]);
  expect(text).toBe("orders-P1、payments-P0");
  const long = unownedText(
    Array.from({ length: 7 }, (_, index) => offset("orders", index)),
    3,
  );
  expect(long).toContain("等 7 个");
});
