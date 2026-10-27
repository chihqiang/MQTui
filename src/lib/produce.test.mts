// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_DELIVERY_MODE,
  contentField,
  contentFieldProblem,
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

test("内容类型留空等于没填，不往后端送空串", () => {
  assert.equal(contentField(""), undefined);
  assert.equal(contentField("   "), undefined);
  assert.equal(contentField(" application/json "), "application/json");
});

test("内容类型里不能有空格", () => {
  assert.equal(contentFieldProblem("内容类型", "application/json"), null);
  assert.equal(contentFieldProblem("内容类型", "application / json"), "内容类型里不能有空格");
  // 空串不是错误：表单清空格子就会是这样。
  assert.equal(contentFieldProblem("内容类型", ""), null);
});

test("内容类型按字节数限长，不是按字符数", () => {
  // 255 个 ASCII 字符刚好是 AMQP shortstr 的上限。
  assert.equal(contentFieldProblem("内容类型", "a".repeat(255)), null);
  assert.equal(contentFieldProblem("内容类型", "a".repeat(256)), "内容类型最长 255 字节");
  // 中文一个字符占三字节：85 个字符就已经 255 字节。
  assert.equal(contentFieldProblem("内容类型", "字".repeat(85)), null);
  assert.equal(contentFieldProblem("内容类型", "字".repeat(86)), "内容类型最长 255 字节");
});

test("内容类型不合法时整条消息发不出去", () => {
  const base = { kind: "rabbitMq" as const, exchange: "ex", routingKey: "k", payload: "{}" };
  assert.equal(sendBlockers({ ...base, contentType: "application/json" }), null);
  assert.equal(
    sendBlockers({ ...base, contentType: "application / json" }),
    "内容类型里不能有空格",
  );
  assert.equal(sendBlockers({ ...base, contentEncoding: "g zip" }), "内容编码里不能有空格");
});

test("默认内容类型仍是 text/plain，且候选里包含它", () => {
  // 换默认值等于让所有没填这一格的消息在下游换一条路走，不能顺手改。
  assert.equal(DEFAULT_CONTENT_TYPE, "text/plain");
  assert.ok(CONTENT_TYPES.some((item) => item.value === DEFAULT_CONTENT_TYPE));
});
