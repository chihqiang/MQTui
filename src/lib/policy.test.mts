// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  describeDefinition,
  describeImpact,
  fromRows,
  isDirty,
  specFromPolicy,
  toRows,
  validateSpec,
} from "./policy.ts";

const baseSpec = {
  name: "orders-ttl",
  pattern: "^orders\\.",
  priority: 0,
  applyTo: "queues" as const,
  definition: [{ key: "x-message-ttl", value: "60000" }],
};

test("name must not be blank or padded", () => {
  assert.match(validateSpec({ ...baseSpec, name: " " }) ?? "", /不能为空/);
  assert.match(validateSpec({ ...baseSpec, name: " p " }) ?? "", /空白/);
  assert.equal(validateSpec(baseSpec), null);
});

test("empty definition is rejected", () => {
  assert.match(validateSpec({ ...baseSpec, definition: [] }) ?? "", /至少要包含/);
});

test("blank value tells user to delete the row", () => {
  const error = validateSpec({
    ...baseSpec,
    definition: [{ key: "x-max-length", value: "  " }],
  });
  assert.match(error ?? "", /删除该行/);
});

test("x-overflow only accepts three modes", () => {
  const make = (value: string) =>
    validateSpec({ ...baseSpec, definition: [{ key: "x-overflow", value }] });
  assert.equal(make("drop-head"), null);
  assert.equal(make("reject-publish"), null);
  assert.equal(make("reject-publish-dlx"), null);
  assert.match(make("drop-tail") ?? "", /x-overflow/);
});

test("x-max-length-bytes is not confused with x-max-length", () => {
  // 回归：用 includes 判断整数项时，`x-max-length-bytes` 会因为含有
  // `x-max-length` 被一起算进来，然后被判成「必须是整数」——
  // 可它本来就是整数，问题在值被拦在了别的规则上。
  const make = (key: string, value: string) =>
    validateSpec({ ...baseSpec, definition: [{ key, value }] });

  assert.equal(make("x-max-length-bytes", "1048576"), null);
  assert.equal(make("x-max-length", "1048576"), null);
  assert.match(make("x-max-length-bytes", "1MB") ?? "", /必须是整数/);
  // 非整数项的文本值不该被整数规则误伤。
  assert.equal(make("x-dead-letter-exchange", "dlx.v2"), null);
});

test("x-queue-master-locator is an enum, not a boolean", () => {
  const make = (value: string) =>
    validateSpec({ ...baseSpec, definition: [{ key: "x-queue-master-locator", value }] });
  assert.equal(make("min-masters"), null);
  assert.equal(make("client-local"), null);
  assert.equal(make("random"), null);
  assert.match(make("nearest") ?? "", /x-queue-master-locator/);
});

test("rows drop blank keys but keep the rest in order", () => {
  const entries = fromRows([
    { key: " x-message-ttl ", value: "1", draft: " 60000 " },
    { key: "  ", value: "1", draft: "x" },
    { key: "ha-mode", value: "all", draft: "all" },
  ]);
  assert.deepEqual(entries, [
    { key: "x-message-ttl", value: "60000" },
    { key: "ha-mode", value: "all" },
  ]);
});

test("dirty means draft differs from current value", () => {
  assert.equal(isDirty({ key: "k", value: "1", draft: "1" }), false);
  assert.equal(isDirty({ key: "k", value: "1", draft: "2" }), true);
});

test("spec round-trips through rows without losing values", () => {
  const rows = toRows(baseSpec.definition);
  assert.deepEqual(fromRows(rows), baseSpec.definition);

  // 编辑既有策略时，原值进 value、草稿进 draft：否则一打开就显示「有改动」。
  const spec = specFromPolicy({
    name: "p",
    vhost: "/",
    pattern: ".*",
    priority: 3,
    applyTo: "all",
    definition: [{ key: "x-expires", value: "1000" }],
  });
  const opened = toRows(spec.definition);
  assert.equal(opened[0].value, "1000");
  assert.equal(opened[0].draft, "1000");
  assert.equal(opened.some(isDirty), false);
});

test("definition summary folds the tail into +N", () => {
  assert.equal(describeDefinition([]), "（空定义）");
  assert.equal(describeDefinition([{ key: "a", value: "1" }]), "a=1");
  assert.equal(
    describeDefinition([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
      { key: "c", value: "3" },
    ]),
    "a=1 · b=2 · +1",
  );
});

test("impact text always reads as an estimate", () => {
  assert.match(describeImpact({ queues: 3, exchanges: 0 }), /约 3 个队列/);
  assert.match(describeImpact({ queues: 0, exchanges: 2 }), /约 2 个交换机/);
  assert.match(describeImpact({ queues: 0, exchanges: 0 }), /没有资源命中/);
});
