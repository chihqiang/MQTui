// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  DEFAULT_DELIVERY_MODE,
  exchangeName,
  kafkaKey,
  sendBlockers,
  toHeaders,
} from "./produce.ts";

test("空 key 的 header 行被丢掉", () => {
  assert.deepEqual(
    toHeaders([
      { key: "trace-id", value: "abc" },
      { key: "  ", value: "x" },
      { key: "empty", value: "" },
    ]),
    [
      { key: "trace-id", value: "abc" },
      { key: "empty", value: "" },
    ],
  );
});

test("Kafka 空 key 降级成 undefined，不是空串", () => {
  assert.equal(kafkaKey(""), undefined);
  assert.equal(kafkaKey("  "), undefined);
  assert.equal(kafkaKey("order-1"), "order-1");
});

test("exchange 去空白；空串仍是默认交换机", () => {
  assert.equal(exchangeName("  "), "");
  assert.equal(exchangeName(" orders.exchange "), "orders.exchange");
});

test("payload 为空一律拦下", () => {
  assert.equal(sendBlockers({ kind: "kafka", topic: "t", payload: "" }), "消息内容不能为空");
  assert.equal(
    sendBlockers({ kind: "rabbitMq", routingKey: "q", payload: "" }),
    "消息内容不能为空",
  );
});

test("Kafka 只要求 topic", () => {
  assert.equal(sendBlockers({ kind: "kafka", topic: "  ", payload: "x" }), "先选一个 topic");
  assert.equal(sendBlockers({ kind: "kafka", topic: "orders", payload: "x" }), null);
});

test("RabbitMQ 默认交换机下必须有 routing key", () => {
  assert.equal(
    sendBlockers({ kind: "rabbitMq", exchange: "", routingKey: "", payload: "x" }),
    "默认交换机需要 routing key（通常就是队列名）",
  );
  assert.equal(sendBlockers({ kind: "rabbitMq", exchange: "", routingKey: "q", payload: "x" }), null);
  assert.equal(
    sendBlockers({ kind: "rabbitMq", exchange: "ex", routingKey: "", payload: "x" }),
    null,
  );
});

test("默认投递模式是非持久化", () => {
  assert.equal(DEFAULT_DELIVERY_MODE, 1);
});
