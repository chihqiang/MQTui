/**
 * 位点重置展示逻辑的单测。
 *
 * 这组断言保护的是一个产品判断：**「重放」和「跳过」必须用不同的说法和颜色**。
 * 把两者都显示成「有变化」，用户就没法在按下确认之前判断这次操作的后果。
 */

import { expect, test } from "vitest";

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
  expect(describeStep(step)).toBe("重放 50 条");
  expect(describeStep({ ...step, to: 90, delta: -40 })).toBe("跳过 40 条");
  expect(describeStep({ ...step, changed: false, delta: 0 })).toBe("无变化");
});

test("重放是 warning，跳过是 danger", () => {
  const base = { partition: 0, from: 50, to: 0, changed: true };
  expect(stepTone({ ...base, delta: 50 })).toBe("warning");
  expect(stepTone({ ...base, delta: -50 })).toBe("danger");
  expect(stepTone({ ...base, delta: 0, changed: false })).toBe("neutral");
});

test("有阻断原因时计划整体是 danger", () => {
  expect(planTone(plan({ blockers: ["位点越界"] }))).toBe("danger");
});

test("只有重放时计划是 warning", () => {
  expect(planTone(plan({ replay: 10 }))).toBe("warning");
});

test("影响描述必须带数字和不可撤销提示", () => {
  const text = describeImpact(plan({ replay: 120, skip: 8 }));
  expect(text).toMatch(/120/);
  expect(text).toMatch(/8/);
  expect(text).toMatch(/不可撤销/);
});

test("没有变化时明确说没有变化", () => {
  expect(describeImpact(plan())).toBe("位点没有变化");
});

test("确认串固定为 reset + 消费组名", () => {
  expect(confirmToken("orders")).toBe("reset orders");
  expect(confirmSatisfied("reset orders", "orders")).toBe(true);
  expect(confirmSatisfied(" reset orders ", "orders")).toBe(true);
  expect(confirmSatisfied("reset", "orders")).toBe(false);
});

test("有阻断原因时不能提交，即便确认串对", () => {
  const item = plan({
    blockers: ["位点越界"],
    steps: [{ partition: 0, from: 1, to: 2, delta: 1, changed: true }],
  });
  expect(canSubmit(item, "reset orders", "orders")).toBe(false);
});

test("没有实际改动时不能提交", () => {
  const item = plan({ steps: [{ partition: 0, from: 1, to: 1, delta: 0, changed: false }] });
  expect(canSubmit(item, "reset orders", "orders")).toBe(false);
  expect(changedCount(item)).toBe(0);
});

test("条件齐备时可以提交", () => {
  const item = plan({ steps: [{ partition: 0, from: 1, to: 0, delta: 1, changed: true }] });
  expect(canSubmit(item, "reset orders", "orders")).toBe(true);
  expect(changedCount(item)).toBe(1);
});
