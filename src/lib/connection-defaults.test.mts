/**
 * 连接默认值的单测。
 *
 * 这几行值原先在三个页面里各写了一遍，抄错的代价是用户打开表单就看见一台
 * 不存在的机器 —— 不报错，只是连不上。所以盯住两件事：默认值本身，
 * 以及 `withEndpoint` 只换地址、不顺手改别的字段。
 */

import { expect, test } from "vitest";

import {
  CONNECTION_DEFAULTS,
  defaultConnection,
  endpointOf,
  splitHostPort,
  withEndpoint,
} from "./connection-defaults.ts";

test("Kafka 的默认配置是本地明文直连", () => {
  const config = defaultConnection("kafka");
  expect(config.kind).toBe("kafka");
  expect(config.brokers).toEqual([CONNECTION_DEFAULTS.kafka.brokers]);
  expect(config.tls).toBe("disabled");
  expect(config.auth.mechanism).toBe("none");
  expect(config.options).toEqual({});
});

test("RabbitMQ 的默认配置是本地 guest", () => {
  const config = defaultConnection("rabbitMq");
  expect(config.kind).toBe("rabbitMq");
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(5672);
  expect(config.auth.username).toBe("guest");
  expect(config.auth.vhost).toBe("/");
});

test("默认配置每次都是新的，改一份不会污染下一份", () => {
  const first = defaultConnection("kafka");
  first.brokers.push("10.0.0.1:9092");
  first.auth.username = "someone";
  expect(defaultConnection("kafka").brokers).toEqual([CONNECTION_DEFAULTS.kafka.brokers]);
  expect(defaultConnection("kafka").auth.username).toBe("");
});

test("address 换进配置时只动地址", () => {
  const kafka = withEndpoint(defaultConnection("kafka"), "10.0.0.1:9093, 10.0.0.2:9093");
  expect(kafka.kind).toBe("kafka");
  expect(kafka.kind === "kafka" ? kafka.brokers : []).toEqual(["10.0.0.1:9093", "10.0.0.2:9093"]);
  expect(kafka.tls).toBe("disabled");

  const rabbit = withEndpoint(defaultConnection("rabbitMq"), "rabbit:5673");
  expect(rabbit.kind === "rabbitMq" ? rabbit.host : "").toBe("rabbit");
  expect(rabbit.kind === "rabbitMq" ? rabbit.port : 0).toBe(5673);
  expect(rabbit.kind === "rabbitMq" ? rabbit.auth.vhost : "").toBe("/");
});

test("地址里没端口时沿用底子里的端口", () => {
  const config = withEndpoint(defaultConnection("rabbitMq"), "rabbit");
  expect(config.kind === "rabbitMq" ? config.port : 0).toBe(5672);
});

test("只拆「主机:端口」，拆不出来就把整段当主机", () => {
  expect(splitHostPort("rabbit:5673")).toEqual({ host: "rabbit", port: 5673 });
  expect(splitHostPort("rabbit")).toEqual({ host: "rabbit" });
  expect(splitHostPort("rabbit:")).toEqual({ host: "rabbit:" });
  // IPv6 字面量不硬拆：拆错了会去连一台不存在的机器。
  expect(splitHostPort("[::1]:5672")).toEqual({ host: "::1", port: 5672 });
  expect(splitHostPort("::1")).toEqual({ host: "::1" });
});

test("端点措辞两种中间件各说各的", () => {
  expect(endpointOf(defaultConnection("kafka"))).toBe("127.0.0.1:9092");
  expect(endpointOf(defaultConnection("rabbitMq"))).toBe("127.0.0.1:5672");
});
