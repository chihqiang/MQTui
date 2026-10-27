import { expect, test } from "vitest";

import {
  buildRequest,
  canSubmit,
  checkBoundary,
  confirmNotes,
  parseBoundary,
  removedText,
  scopeText,
} from "./purge.ts";
import type { PurgePlan } from "../types/topic-purge.ts";

const NOW = 1_700_000_000_000;

function plan(patch: Partial<PurgePlan> = {}): PurgePlan {
  return {
    topic: "orders",
    kind: "truncate",
    partitions: [
      { partition: 0, currentLow: 0, currentHigh: 100, targetLow: 100 },
      { partition: 1, currentLow: 0, currentHigh: 50, targetLow: 50 },
    ],
    removed: 150,
    notes: ["全部分区的可读消息会立刻消失"],
    ...patch,
  };
}

test("时间输入解析成毫秒，空值与垃圾值都退回 undefined", () => {
  expect(parseBoundary("2023-11-14T22:13:20")).toBe(Date.parse("2023-11-14T22:13:20"));
  expect(parseBoundary("   ")).toBe(undefined);
  expect(parseBoundary("不是时间")).toBe(undefined);
});

test("未来的截止时间会被拦下，因为那等于清空主题", () => {
  expect(checkBoundary(NOW + 3_600_000, NOW) ?? "").toMatch(/未来/);
  // 一分钟内的偏差是两台机器时钟不同步，不该拦。
  expect(checkBoundary(NOW - 1_000, NOW)).toBe(undefined);
  expect(checkBoundary(NOW + 30_000, NOW)).toBe(undefined);
});

test("没填与填了非正数都给出可读理由", () => {
  expect(checkBoundary(undefined, NOW) ?? "").toMatch(/请填写/);
  expect(checkBoundary(0, NOW) ?? "").toMatch(/正数/);
});

test("条数与范围文案不复述后端原文", () => {
  expect(removedText(plan())).toBe("将删除 150 条消息");
  expect(removedText(plan({ removed: 0, partitions: [] }))).toBe("没有消息会被删除");
  expect(scopeText(plan())).toBe("涉及 2 个分区");
  expect(scopeText(plan({ blocked: "内部主题" }))).toMatch(/不可提交/);
});

test("确认框的第一条永远是「不可逆」", () => {
  const notes = confirmNotes(plan());
  expect(notes[0]).toMatch(/不可逆/);
  expect(notes.length).toBe(2);
});

test("计划不可提交时按钮不能亮", () => {
  expect(canSubmit(undefined)).toBe(false);
  expect(canSubmit(plan({ blocked: "内部主题" }))).toBe(false);
  expect(canSubmit(plan({ partitions: [] }))).toBe(false);
  expect(canSubmit(plan())).toBe(true);
});

test("请求只带用得上的字段，分区去重排序", () => {
  const truncate = buildRequest("orders", "truncate", NOW, [1, 0, 1]);
  expect(truncate).toEqual({ topic: "orders", kind: "truncate", partitions: [0, 1] });
  const byTime = buildRequest("orders", "deleteBefore", NOW, []);
  expect(byTime.before).toBe(NOW);
  expect(byTime.partitions).toEqual([]);
});
