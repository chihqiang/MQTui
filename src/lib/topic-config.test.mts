import { expect, test } from "vitest";

import type { ConfigPlan } from "../types/topic-config.ts";
import {
  collectChanges,
  describePlan,
  describeValue,
  hasChanges,
  isRisky,
  lockOf,
  planImpacts,
  planItems,
  submitChanges,
  missingConfigs,
  rowState,
} from "./topic-config.ts";

test("内部主题的所有配置都不可编辑", () => {
  expect(lockOf("retention.ms", true)).toBe("internal");
  expect(rowState({ key: "retention.ms", value: "1", draft: "2" }, true).dirty).toBe(false);
  expect(rowState({ key: "retention.ms", value: "1", draft: "1" }, true).reason).toBeTruthy();
});

test("运行时不可改的项单独列出", () => {
  expect(lockOf("partition_count", false)).toBe("readOnly");
  expect(rowState({ key: "partition_count", value: "3", draft: "6" }, false).reason).toBeTruthy();
  expect(lockOf("retention.ms", false)).toBe("editable");
});

test("只有值变化才算改动", () => {
  const rows = [
    { key: "retention.ms", value: "1000", draft: "1000" },
    { key: "segment.bytes", value: "1024", draft: "2048" },
  ];
  expect(rowState(rows[0], false).dirty).toBe(false);
  expect(rowState(rows[1], false).dirty).toBe(true);
  expect(hasChanges(rows)).toBe(true);
  expect(collectChanges(rows)).toEqual([{ key: "segment.bytes", value: "2048" }]);
});

test("空改动不产生变更列表", () => {
  const rows = [{ key: "retention.ms", value: "1000", draft: "1000" }];
  expect(hasChanges(rows)).toBe(false);
  expect(collectChanges([])).toEqual([]);
});

test("清空值展示为默认值", () => {
  expect(describeValue("")).toBe("默认值");
  expect(describeValue("   ")).toBe("默认值");
  expect(describeValue("604800000")).toBe("604800000");
});

test("计划描述说清改动前后", () => {
  const plan: ConfigPlan = {
    topic: "orders",
    items: [
      { key: "retention.ms", value: "", previous: "1000" },
      { key: "segment.bytes", value: "2048", previous: "" },
    ],
    impacts: ["调小会立刻触发清理"],
  };
  expect(describePlan(plan)).toEqual([
    "retention.ms: 1000 → 默认值",
    "segment.bytes: 默认值 → 2048",
  ]);
  expect(isRisky(plan)).toBe(true);
});

test("没有副作用的计划不算高风险", () => {
  const plan: ConfigPlan = { topic: "orders", items: [] };
  expect(isRisky(plan)).toBe(false);
  expect(planImpacts(plan)).toEqual([]);
  expect(describePlan(plan)).toEqual([]);
});

test("后端省略 impacts 与 items 时按空处理", () => {
  // 后端对空数组不序列化，屏幕上却必须还能渲染 —— 缺字段不是崩溃的理由。
  const plan = { topic: "orders" } as ConfigPlan;
  expect(planImpacts(plan)).toEqual([]);
  expect(isRisky(plan)).toBe(false);
  expect(describePlan(plan)).toEqual([]);
});

test("整个计划缺席时确认框不崩", () => {
  // 确认框关着的时候 plan 就是 null；渲染路径不能假定它一定在。
  expect(isRisky(null)).toBe(false);
  expect(planImpacts(null)).toEqual([]);
  expect(planItems(null)).toEqual([]);
  expect(describePlan(null)).toEqual([]);
  expect(submitChanges(null)).toEqual([]);
  expect(isRisky(undefined)).toBe(false);
});

test("提交只取计划里的 key 与值", () => {
  const plan: ConfigPlan = {
    topic: "orders",
    items: [
      { key: "retention.ms", value: "1000", previous: "", impact: "调小会立刻触发清理" },
      { key: "segment.bytes", value: "", previous: "2048" },
    ],
  };
  expect(submitChanges(plan)).toEqual([
    { key: "retention.ms", value: "1000" },
    { key: "segment.bytes", value: "" },
  ]);
  expect(submitChanges(plan)).toEqual(plan.items.map(({ key, value }) => ({ key, value })));
});

test("只列出尚未配置的可选项", () => {
  const rows = [
    { key: "retention.ms", value: "1000", draft: "1000" },
    { key: "cleanup.policy", value: "compact", draft: "compact" },
  ];
  const missing = missingConfigs(rows).map((item) => item.key);
  expect(missing.includes("retention.ms")).toBe(false);
  expect(missing.includes("cleanup.policy")).toBe(false);
  expect(missing.includes("segment.bytes")).toBeTruthy();
  expect(missingConfigs([]).length > 0).toBe(true);
});
