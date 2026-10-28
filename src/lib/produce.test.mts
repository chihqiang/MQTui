import { expect, test } from "vitest";

import {
  CONTENT_ENCODINGS,
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_DELIVERY_MODE,
  HEADER_NAMES,
  guessContentType,
  contentField,
  contentFieldProblem,
  exchangeName,
  kafkaKey,
  emptyRouteHint,
  sendBlockers,
  toHeaders,
} from "./produce.ts";

test("空 key 的 header 行被丢掉", () => {
  expect(toHeaders([
      { key: "trace-id", value: "abc" },
      { key: "  ", value: "x" },
      { key: "empty", value: "" },
    ])).toEqual([
      { key: "trace-id", value: "abc" },
      { key: "empty", value: "" },
    ]);
});

test("Kafka 空 key 降级成 undefined，不是空串", () => {
  expect(kafkaKey("")).toBe(undefined);
  expect(kafkaKey("  ")).toBe(undefined);
  expect(kafkaKey("order-1")).toBe("order-1");
});

test("exchange 去空白；空串仍是默认交换机", () => {
  expect(exchangeName("  ")).toBe("");
  expect(exchangeName(" orders.exchange ")).toBe("orders.exchange");
});

test("payload 为空一律拦下", () => {
  expect(sendBlockers({ kind: "kafka", topic: "t", payload: "" })).toBe("消息内容不能为空");
  expect(sendBlockers({ kind: "rabbitMq", routingKey: "q", payload: "" })).toBe("消息内容不能为空");
});

test("Kafka 只要求 topic", () => {
  expect(sendBlockers({ kind: "kafka", topic: "  ", payload: "x" })).toBe("先选一个 topic");
  expect(sendBlockers({ kind: "kafka", topic: "orders", payload: "x" })).toBe(null);
});

test("RabbitMQ 默认交换机下必须有 routing key", () => {
  expect(sendBlockers({ kind: "rabbitMq", exchange: "", routingKey: "", payload: "x" })).toBe("默认交换机需要 routing key（通常就是队列名）");
  expect(sendBlockers({ kind: "rabbitMq", exchange: "", routingKey: "q", payload: "x" })).toBe(null);
  expect(sendBlockers({ kind: "rabbitMq", exchange: "ex", routingKey: "", payload: "x" })).toBe(null);
});

test("默认投递模式是非持久化", () => {
  expect(DEFAULT_DELIVERY_MODE).toBe(1);
});

test("内容类型留空等于没填，不往后端送空串", () => {
  expect(contentField("")).toBe(undefined);
  expect(contentField("   ")).toBe(undefined);
  expect(contentField(" application/json ")).toBe("application/json");
});

test("内容类型里不能有空格", () => {
  expect(contentFieldProblem("内容类型", "application/json")).toBe(null);
  expect(contentFieldProblem("内容类型", "application / json")).toBe("内容类型里不能有空格");
  // 空串不是错误：表单清空格子就会是这样。
  expect(contentFieldProblem("内容类型", "")).toBe(null);
});

test("内容类型按字节数限长，不是按字符数", () => {
  // 255 个 ASCII 字符刚好是 AMQP shortstr 的上限。
  expect(contentFieldProblem("内容类型", "a".repeat(255))).toBe(null);
  expect(contentFieldProblem("内容类型", "a".repeat(256))).toBe("内容类型最长 255 字节");
  // 中文一个字符占三字节：85 个字符就已经 255 字节。
  expect(contentFieldProblem("内容类型", "字".repeat(85))).toBe(null);
  expect(contentFieldProblem("内容类型", "字".repeat(86))).toBe("内容类型最长 255 字节");
});

test("内容类型不合法时整条消息发不出去", () => {
  const base = { kind: "rabbitMq" as const, exchange: "ex", routingKey: "k", payload: "{}" };
  expect(sendBlockers({ ...base, contentType: "application/json" })).toBe(null);
  expect(sendBlockers({ ...base, contentType: "application / json" })).toBe("内容类型里不能有空格");
  expect(sendBlockers({ ...base, contentEncoding: "g zip" })).toBe("内容编码里不能有空格");
});

test("默认内容类型仍是 text/plain，且候选里包含它", () => {
  // 换默认值等于让所有没填这一格的消息在下游换一条路走，不能顺手改。
  expect(DEFAULT_CONTENT_TYPE).toBe("text/plain");
  expect(CONTENT_TYPES.some((item) => item.value === DEFAULT_CONTENT_TYPE)).toBeTruthy();
});

test("payload 像 JSON 时才提示，猜不出来就闭嘴", () => {
  expect(guessContentType('{"a":1}')).toBe("application/json");
  expect(guessContentType("  [1,2]  ")).toBe("application/json");
  expect(guessContentType("<order></order>")).toBe("application/xml");
  // 看着像 JSON 但解析不了：不能提示，否则等于教人标错类型。
  expect(guessContentType('{"a":}')).toBe(null);
  expect(guessContentType("123")).toBe(null);
  expect(guessContentType("")).toBe(null);
});

test("header 名候选可敲可点，去重后仍是纯值列表", () => {
  expect(HEADER_NAMES.some((item) => item.value === "trace-id")).toBeTruthy();
  expect(HEADER_NAMES.every((item) => item.hint.length > 0)).toBeTruthy();
  expect(CONTENT_ENCODINGS.some((item) => item.value === "gzip")).toBeTruthy();
});

test("空路由：数据不全时说「没法核对」，不说「会丢」", () => {
  const hint = emptyRouteHint({
    exchange: "t",
    queues: [],
    bindingsKnown: false,
  });
  expect(hint).toContain("没法核对");
  expect(hint).toContain("不代表消息会丢");
});

test("空路由：数据齐备时才敢说消息会被丢弃", () => {
  const hint = emptyRouteHint({ exchange: "t", queues: [] });
  expect(hint).toContain("丢弃");
  expect(hint).not.toContain("没法核对");
});
