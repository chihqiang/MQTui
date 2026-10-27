import { expect, test } from "vitest";

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
  expect(validateSpec({ ...baseSpec, name: " " }) ?? "").toMatch(/不能为空/);
  expect(validateSpec({ ...baseSpec, name: " p " }) ?? "").toMatch(/空白/);
  expect(validateSpec(baseSpec)).toBe(null);
});

test("empty definition is rejected", () => {
  expect(validateSpec({ ...baseSpec, definition: [] }) ?? "").toMatch(/至少要包含/);
});

test("blank value tells user to delete the row", () => {
  const error = validateSpec({
    ...baseSpec,
    definition: [{ key: "x-max-length", value: "  " }],
  });
  expect(error ?? "").toMatch(/删除该行/);
});

test("x-overflow only accepts three modes", () => {
  const make = (value: string) =>
    validateSpec({ ...baseSpec, definition: [{ key: "x-overflow", value }] });
  expect(make("drop-head")).toBe(null);
  expect(make("reject-publish")).toBe(null);
  expect(make("reject-publish-dlx")).toBe(null);
  expect(make("drop-tail") ?? "").toMatch(/x-overflow/);
});

test("x-max-length-bytes is not confused with x-max-length", () => {
  // 回归：用 includes 判断整数项时，`x-max-length-bytes` 会因为含有
  // `x-max-length` 被一起算进来，然后被判成「必须是整数」——
  // 可它本来就是整数，问题在值被拦在了别的规则上。
  const make = (key: string, value: string) =>
    validateSpec({ ...baseSpec, definition: [{ key, value }] });

  expect(make("x-max-length-bytes", "1048576")).toBe(null);
  expect(make("x-max-length", "1048576")).toBe(null);
  expect(make("x-max-length-bytes", "1MB") ?? "").toMatch(/必须是整数/);
  // 非整数项的文本值不该被整数规则误伤。
  expect(make("x-dead-letter-exchange", "dlx.v2")).toBe(null);
});

test("x-queue-master-locator is an enum, not a boolean", () => {
  const make = (value: string) =>
    validateSpec({ ...baseSpec, definition: [{ key: "x-queue-master-locator", value }] });
  expect(make("min-masters")).toBe(null);
  expect(make("client-local")).toBe(null);
  expect(make("random")).toBe(null);
  expect(make("nearest") ?? "").toMatch(/x-queue-master-locator/);
});

test("rows drop blank keys but keep the rest in order", () => {
  const entries = fromRows([
    { key: " x-message-ttl ", value: "1", draft: " 60000 " },
    { key: "  ", value: "1", draft: "x" },
    { key: "ha-mode", value: "all", draft: "all" },
  ]);
  expect(entries).toEqual([
    { key: "x-message-ttl", value: "60000" },
    { key: "ha-mode", value: "all" },
  ]);
});

test("dirty means draft differs from current value", () => {
  expect(isDirty({ key: "k", value: "1", draft: "1" })).toBe(false);
  expect(isDirty({ key: "k", value: "1", draft: "2" })).toBe(true);
});

test("spec round-trips through rows without losing values", () => {
  const rows = toRows(baseSpec.definition);
  expect(fromRows(rows)).toEqual(baseSpec.definition);

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
  expect(opened[0].value).toBe("1000");
  expect(opened[0].draft).toBe("1000");
  expect(opened.some(isDirty)).toBe(false);
});

test("definition summary folds the tail into +N", () => {
  expect(describeDefinition([])).toBe("（空定义）");
  expect(describeDefinition([{ key: "a", value: "1" }])).toBe("a=1");
  expect(describeDefinition([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
      { key: "c", value: "3" },
    ])).toBe("a=1 · b=2 · +1");
});

test("impact text always reads as an estimate", () => {
  expect(describeImpact({ queues: 3, exchanges: 0 })).toMatch(/约 3 个队列/);
  expect(describeImpact({ queues: 0, exchanges: 2 })).toMatch(/约 2 个交换机/);
  expect(describeImpact({ queues: 0, exchanges: 0 })).toMatch(/没有资源命中/);
});
