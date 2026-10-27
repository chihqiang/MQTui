/** 交换机页纯逻辑的单测：唯一键、速率文案、可删性、过滤。 */

import { expect, test } from "vitest";

import { bindingKey, filterTopology, formatRate, initialBinding, removalReason } from "./exchange.ts";

const binding = {
  source: "e1",
  destination: "same",
  destinationType: "queue",
  routingKey: "k1",
  arguments: [],
};

test("同名队列与同名交换机的绑定键必须不同", () => {
  const asQueue = { ...binding, destinationType: "queue" } as never;
  const asExchange = { ...binding, destinationType: "exchange" } as never;
  expect(bindingKey(asQueue)).not.toBe(bindingKey(asExchange));
});

test("同一对节点的不同 routing key 是两条绑定", () => {
  expect(bindingKey({ ...binding, routingKey: "a" } as never)).not.toBe(bindingKey({ ...binding, routingKey: "b" } as never));
});

test("速率为 0 不显示 0.00/s", () => {
  expect(formatRate({ messageRate: 0 } as never)).toBe("-");
  expect(formatRate({ messageRate: 1.234 } as never)).toBe("1.23/s");
});

test("默认交换机与 amq. 前缀不可删", () => {
  expect(removalReason({ name: "", internal: false } as never)).toBeTruthy();
  expect(removalReason({ name: "amq.topic", internal: false } as never)).toBeTruthy();
  expect(removalReason({ name: "orders", internal: false } as never)).toBe(null);
});

test("选中交换机后只留与它相关的绑定", () => {
  const data = {
    exchanges: [{ name: "e1" }, { name: "e2" }] as never,
    bindings: [
      { source: "e1", destination: "q1", routingKey: "a" },
      { source: "e2", destination: "q2", routingKey: "b" },
    ] as never,
  };
  const filtered = filterTopology(data, "", "e1");
  expect(filtered.bindings.length).toBe(1);
  expect(filtered.bindings[0].destination).toBe("q1");
});

test("关键字命中目标或 routing key 都算", () => {
  const data = {
    exchanges: [] as never,
    bindings: [{ source: "e1", destination: "orders", routingKey: "created" }] as never,
  };
  expect(filterTopology(data, "orders", null).bindings.length).toBe(1);
  expect(filterTopology(data, "creat", null).bindings.length).toBe(1);
  expect(filterTopology(data, "nothing", null).bindings.length).toBe(0);
});

test("新建绑定只认源交换机", () => {
  const spec = initialBinding("e1");
  expect(spec.source).toBe("e1");
  expect(spec.destination.name).toBe("");
});
