/**
 * 位点重置展示逻辑的单测。
 *
 * 这组断言保护的是一个产品判断：**「重放」和「跳过」必须用不同的说法和颜色**。
 * 把两者都显示成「有变化」，用户就没法在按下确认之前判断这次操作的后果。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  canSubmit,
  changedCount,
  confirmSatisfied,
  confirmToken,
  describeImpact,
  describeStep,
  planTone,
  stepTone,
} from "./offset-reset.ts";

function plan(overrides = {}) {
  return {
    target: "earliest" as const,
    targetLabel: "最早位点",
    steps: [] as { partition: number; from: number | null; to: number; delta: number; changed: boolean }[],
    replay: 0,
    skip: 0,
    blockers: [] as string[],
    notes: [] as string[],
    ...overrides,
  };
}

test("正 delta 说「重放」，负 delta 说「跳过」", () => {
  const step = { partition: 0, from: 50, to: 0, delta: 50, changed: true };
  assert.equal(describeStep(step), "重放 50 条");
  assert.equal(describeStep({ ...step, to: 90, delta: -40 }), "跳过 40 条");
  assert.equal(describeStep({ ...step, changed: false, delta: 0 }), "无变化");
});

test("重放是 warning，跳过是 danger", () => {
  const base = { partition: 0, from: 50, to: 0, changed: true };
  assert.equal(stepTone({ ...base, delta: 50 }), "warning");
  assert.equal(stepTone({ ...base, delta: -50 }), "danger");
  assert.equal(stepTone({ ...base, delta: 0, changed: false }), "neutral");
});

test("有阻断原因时计划整体是 danger", () => {
  assert.equal(planTone(plan({ blockers: ["位点越界"] })), "danger");
});

test("只有重放时计划是 warning", () => {
  assert.equal(planTone(plan({ replay: 10 })), "warning");
});

test("影响描述必须带数字和不可撤销提示", () => {
  const text = describeImpact(plan({ replay: 120, skip: 8 }));
  assert.match(text, /120/);
  assert.match(text, /8/);
  assert.match(text, /不可撤销/);
});

test("没有变化时明确说没有变化", () => {
  assert.equal(describeImpact(plan()), "位点没有变化");
});

test("确认串固定为 reset + 消费组名", () => {
  assert.equal(confirmToken("orders"), "reset orders");
  assert.equal(confirmSatisfied("reset orders", "orders"), true);
  assert.equal(confirmSatisfied(" reset orders ", "orders"), true);
  assert.equal(confirmSatisfied("reset", "orders"), false);
});

test("有阻断原因时不能提交，即便确认串对", () => {
  const item = plan({
    blockers: ["位点越界"],
    steps: [{ partition: 0, from: 1, to: 2, delta: 1, changed: true }],
  });
  assert.equal(canSubmit(item, "reset orders", "orders"), false);
});

test("没有实际改动时不能提交", () => {
  const item = plan({ steps: [{ partition: 0, from: 1, to: 1, delta: 0, changed: false }] });
  assert.equal(canSubmit(item, "reset orders", "orders"), false);
  assert.equal(changedCount(item), 0);
});

test("条件齐备时可以提交", () => {
  const item = plan({ steps: [{ partition: 0, from: 1, to: 0, delta: 1, changed: true }] });
  assert.equal(canSubmit(item, "reset orders", "orders"), true);
  assert.equal(changedCount(item), 1);
});
