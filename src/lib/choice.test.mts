// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  CHOICE_LIMIT,
  dedupeChoices,
  exactChoices,
  filterChoices,
  routingKeyChoices,
  stepChoice,
} from "./choice.ts";

test("去空、去重、保持顺序", () => {
  const items = dedupeChoices(["b", "  ", "a", "b"]);
  assert.deepEqual(
    items.map((item) => item.value),
    ["b", "a"],
  );
});

test("同名保留先出现的那条分组信息", () => {
  const items = dedupeChoices([{ value: "orders", hint: "最近" }, { value: "orders" }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].hint, "最近");
});

test("后出现的那条带分组时补上空着的分组", () => {
  const items = dedupeChoices([{ value: "orders" }, { value: "orders", hint: "主题" }]);
  assert.equal(items[0].hint, "主题");
});

test("超过上限即截断", () => {
  const many = Array.from({ length: CHOICE_LIMIT + 10 }, (_, index) => `t${index}`);
  assert.equal(dedupeChoices(many).length, CHOICE_LIMIT);
});

test("按子串过滤，不区分大小写", () => {
  const items = dedupeChoices(["orders.created", "Orders.Paid", "users"]);
  assert.deepEqual(
    filterChoices(items, "ORDER").map((item) => item.value),
    ["orders.created", "Orders.Paid"],
  );
});

test("空关键字返回全部", () => {
  const items = dedupeChoices(["a", "b"]);
  assert.equal(filterChoices(items, "   ").length, 2);
});

test("上下键循环，越界从边界重新开始", () => {
  assert.equal(stepChoice(-1, 1, 3), 0);
  assert.equal(stepChoice(-1, -1, 3), 2);
  assert.equal(stepChoice(2, 1, 3), 0);
  assert.equal(stepChoice(0, -1, 3), 2);
  assert.equal(stepChoice(0, 1, 3), 1);
  assert.equal(stepChoice(0, 1, 0), -1);
});

test("没读到与读到空是两件事", () => {
  assert.equal(exactChoices(undefined), null);
  assert.deepEqual(exactChoices([]), []);
  assert.deepEqual(exactChoices(["b", "a", "b"]), ["b", "a"]);
});

test("routing key 候选按来源交换机收口，不限来源时给全部", () => {
  const bindings = [
    { source: "orders.exchange", routingKey: "order.created" },
    { source: "orders.exchange", routingKey: "order.created" },
    { source: "users.exchange", routingKey: "user.created" },
    { source: "orders.exchange", routingKey: "" },
  ];
  assert.deepEqual(routingKeyChoices(bindings, "orders.exchange"), ["order.created"]);
  assert.deepEqual(routingKeyChoices(bindings), ["order.created", "user.created"]);
  assert.equal(routingKeyChoices(undefined), null);
});
