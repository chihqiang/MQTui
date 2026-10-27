/** 交换机页纯逻辑的单测：唯一键、速率文案、可删性、过滤。 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

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
  assert.notEqual(bindingKey(asQueue), bindingKey(asExchange));
});

test("同一对节点的不同 routing key 是两条绑定", () => {
  assert.notEqual(
    bindingKey({ ...binding, routingKey: "a" } as never),
    bindingKey({ ...binding, routingKey: "b" } as never),
  );
});

test("速率为 0 不显示 0.00/s", () => {
  assert.equal(formatRate({ messageRate: 0 } as never), "-");
  assert.equal(formatRate({ messageRate: 1.234 } as never), "1.23/s");
});

test("默认交换机与 amq. 前缀不可删", () => {
  assert.ok(removalReason({ name: "", internal: false } as never));
  assert.ok(removalReason({ name: "amq.topic", internal: false } as never));
  assert.equal(removalReason({ name: "orders", internal: false } as never), null);
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
  assert.equal(filtered.bindings.length, 1);
  assert.equal(filtered.bindings[0].destination, "q1");
});

test("关键字命中目标或 routing key 都算", () => {
  const data = {
    exchanges: [] as never,
    bindings: [{ source: "e1", destination: "orders", routingKey: "created" }] as never,
  };
  assert.equal(filterTopology(data, "orders", null).bindings.length, 1);
  assert.equal(filterTopology(data, "creat", null).bindings.length, 1);
  assert.equal(filterTopology(data, "nothing", null).bindings.length, 0);
});

test("新建绑定只认源交换机", () => {
  const spec = initialBinding("e1");
  assert.equal(spec.source, "e1");
  assert.equal(spec.destination.name, "");
});
