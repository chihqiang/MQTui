import { expect, test } from "vitest";

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
  expect(items.map((item) => item.value)).toEqual(["b", "a"]);
});

test("同名保留先出现的那条分组信息", () => {
  const items = dedupeChoices([{ value: "orders", hint: "最近" }, { value: "orders" }]);
  expect(items.length).toBe(1);
  expect(items[0].hint).toBe("最近");
});

test("后出现的那条带分组时补上空着的分组", () => {
  const items = dedupeChoices([{ value: "orders" }, { value: "orders", hint: "主题" }]);
  expect(items[0].hint).toBe("主题");
});

test("超过上限即截断", () => {
  const many = Array.from({ length: CHOICE_LIMIT + 10 }, (_, index) => `t${index}`);
  expect(dedupeChoices(many).length).toBe(CHOICE_LIMIT);
});

test("按子串过滤，不区分大小写", () => {
  const items = dedupeChoices(["orders.created", "Orders.Paid", "users"]);
  expect(filterChoices(items, "ORDER").map((item) => item.value)).toEqual(["orders.created", "Orders.Paid"]);
});

test("空关键字返回全部", () => {
  const items = dedupeChoices(["a", "b"]);
  expect(filterChoices(items, "   ").length).toBe(2);
});

test("上下键循环，越界从边界重新开始", () => {
  expect(stepChoice(-1, 1, 3)).toBe(0);
  expect(stepChoice(-1, -1, 3)).toBe(2);
  expect(stepChoice(2, 1, 3)).toBe(0);
  expect(stepChoice(0, -1, 3)).toBe(2);
  expect(stepChoice(0, 1, 3)).toBe(1);
  expect(stepChoice(0, 1, 0)).toBe(-1);
});

test("没读到与读到空是两件事", () => {
  expect(exactChoices(undefined)).toBe(null);
  expect(exactChoices([])).toEqual([]);
  expect(exactChoices(["b", "a", "b"])).toEqual(["b", "a"]);
});

test("routing key 候选按来源交换机收口，不限来源时给全部", () => {
  const bindings = [
    { source: "orders.exchange", routingKey: "order.created" },
    { source: "orders.exchange", routingKey: "order.created" },
    { source: "users.exchange", routingKey: "user.created" },
    { source: "orders.exchange", routingKey: "" },
  ];
  expect(routingKeyChoices(bindings, "orders.exchange")).toEqual(["order.created"]);
  expect(routingKeyChoices(bindings)).toEqual(["order.created", "user.created"]);
  expect(routingKeyChoices(undefined)).toBe(null);
});
