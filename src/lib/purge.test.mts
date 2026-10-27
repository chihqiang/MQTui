// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

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
  assert.equal(parseBoundary("2023-11-14T22:13:20"), Date.parse("2023-11-14T22:13:20"));
  assert.equal(parseBoundary("   "), undefined);
  assert.equal(parseBoundary("不是时间"), undefined);
});

test("未来的截止时间会被拦下，因为那等于清空主题", () => {
  assert.match(checkBoundary(NOW + 3_600_000, NOW) ?? "", /未来/);
  // 一分钟内的偏差是两台机器时钟不同步，不该拦。
  assert.equal(checkBoundary(NOW - 1_000, NOW), undefined);
  assert.equal(checkBoundary(NOW + 30_000, NOW), undefined);
});

test("没填与填了非正数都给出可读理由", () => {
  assert.match(checkBoundary(undefined, NOW) ?? "", /请填写/);
  assert.match(checkBoundary(0, NOW) ?? "", /正数/);
});

test("条数与范围文案不复述后端原文", () => {
  assert.equal(removedText(plan()), "将删除 150 条消息");
  assert.equal(removedText(plan({ removed: 0, partitions: [] })), "没有消息会被删除");
  assert.equal(scopeText(plan()), "涉及 2 个分区");
  assert.match(scopeText(plan({ blocked: "内部主题" })), /不可提交/);
});

test("确认框的第一条永远是「不可逆」", () => {
  const notes = confirmNotes(plan());
  assert.match(notes[0], /不可逆/);
  assert.equal(notes.length, 2);
});

test("计划不可提交时按钮不能亮", () => {
  assert.equal(canSubmit(undefined), false);
  assert.equal(canSubmit(plan({ blocked: "内部主题" })), false);
  assert.equal(canSubmit(plan({ partitions: [] })), false);
  assert.equal(canSubmit(plan()), true);
});

test("请求只带用得上的字段，分区去重排序", () => {
  const truncate = buildRequest("orders", "truncate", NOW, [1, 0, 1]);
  assert.deepEqual(truncate, { topic: "orders", kind: "truncate", partitions: [0, 1] });
  const byTime = buildRequest("orders", "deleteBefore", NOW, []);
  assert.equal(byTime.before, NOW);
  assert.deepEqual(byTime.partitions, []);
});
