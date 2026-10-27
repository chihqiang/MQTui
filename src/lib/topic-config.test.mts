// @ts-expect-error node 内置模块未随仓库提供类型声明（与 refresh.test.mts 一致）
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import type { ConfigPlan } from "../types/topic-config.ts";
import {
  collectChanges,
  describePlan,
  describeValue,
  hasChanges,
  isRisky,
  lockOf,
  missingConfigs,
  rowState,
} from "./topic-config.ts";

test("内部主题的所有配置都不可编辑", () => {
  assert.equal(lockOf("retention.ms", true), "internal");
  assert.equal(rowState({ key: "retention.ms", value: "1", draft: "2" }, true).dirty, false);
  assert.ok(rowState({ key: "retention.ms", value: "1", draft: "1" }, true).reason);
});

test("运行时不可改的项单独列出", () => {
  assert.equal(lockOf("partition_count", false), "readOnly");
  assert.ok(rowState({ key: "partition_count", value: "3", draft: "6" }, false).reason);
  assert.equal(lockOf("retention.ms", false), "editable");
});

test("只有值变化才算改动", () => {
  const rows = [
    { key: "retention.ms", value: "1000", draft: "1000" },
    { key: "segment.bytes", value: "1024", draft: "2048" },
  ];
  assert.equal(rowState(rows[0], false).dirty, false);
  assert.equal(rowState(rows[1], false).dirty, true);
  assert.equal(hasChanges(rows), true);
  assert.deepEqual(collectChanges(rows), [{ key: "segment.bytes", value: "2048" }]);
});

test("空改动不产生变更列表", () => {
  const rows = [{ key: "retention.ms", value: "1000", draft: "1000" }];
  assert.equal(hasChanges(rows), false);
  assert.deepEqual(collectChanges([]), []);
});

test("清空值展示为默认值", () => {
  assert.equal(describeValue(""), "默认值");
  assert.equal(describeValue("   "), "默认值");
  assert.equal(describeValue("604800000"), "604800000");
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
  assert.deepEqual(describePlan(plan), [
    "retention.ms: 1000 → 默认值",
    "segment.bytes: 默认值 → 2048",
  ]);
  assert.equal(isRisky(plan), true);
});

test("没有副作用的计划不算高风险", () => {
  const plan: ConfigPlan = { topic: "orders", items: [] };
  assert.equal(isRisky(plan), false);
  assert.deepEqual(describePlan(plan), []);
});

test("只列出尚未配置的可选项", () => {
  const rows = [
    { key: "retention.ms", value: "1000", draft: "1000" },
    { key: "cleanup.policy", value: "compact", draft: "compact" },
  ];
  const missing = missingConfigs(rows).map((item) => item.key);
  assert.ok(!missing.includes("retention.ms"));
  assert.ok(!missing.includes("cleanup.policy"));
  assert.ok(missing.includes("segment.bytes"));
  assert.equal(missingConfigs([]).length > 0, true);
});
