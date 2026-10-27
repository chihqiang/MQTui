/** 孤儿主题页纯逻辑的单测：范围摘要与堆积阈值。 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { describeScope, orphanTone } from "./orphan-topics.ts";

test("什么都没选时是全量扫描", () => {
  assert.equal(describeScope({}), "全量扫描");
  assert.equal(describeScope({ topics: [], prefix: "  " }), "全量扫描");
});

test("主题与前缀同时存在时要都说出来", () => {
  assert.equal(describeScope({ topics: ["a", "b"], prefix: "order." }), "2 个主题 + 前缀 order.");
});

test("堆积越阈就转警示与危险", () => {
  assert.equal(orphanTone(0), "neutral");
  assert.equal(orphanTone(999), "neutral");
  assert.equal(orphanTone(1_000), "warning");
  assert.equal(orphanTone(10_000), "danger");
});
