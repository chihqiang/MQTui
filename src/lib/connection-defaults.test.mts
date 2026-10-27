/**
 * 连接默认值的单测。
 *
 * 这几行值原先在三个页面里各写了一遍，抄错的代价是用户打开表单就看见一台
 * 不存在的机器 —— 不报错，只是连不上。所以盯住两件事：默认值本身，
 * 以及 `withEndpoint` 只换地址、不顺手改别的字段。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  CONNECTION_DEFAULTS,
  defaultConnection,
  endpointOf,
  splitHostPort,
  withEndpoint,
} from "./connection-defaults.ts";

test("Kafka 的默认配置是本地明文直连", () => {
  const config = defaultConnection("kafka");
  assert.equal(config.kind, "kafka");
  assert.deepEqual(config.brokers, [CONNECTION_DEFAULTS.kafka.brokers]);
  assert.equal(config.tls, "disabled");
  assert.equal(config.auth.mechanism, "none");
  assert.deepEqual(config.options, {});
});

test("RabbitMQ 的默认配置是本地 guest", () => {
  const config = defaultConnection("rabbitMq");
  assert.equal(config.kind, "rabbitMq");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 5672);
  assert.equal(config.auth.username, "guest");
  assert.equal(config.auth.vhost, "/");
});

test("默认配置每次都是新的，改一份不会污染下一份", () => {
  const first = defaultConnection("kafka");
  first.brokers.push("10.0.0.1:9092");
  first.auth.username = "someone";
  assert.deepEqual(defaultConnection("kafka").brokers, [CONNECTION_DEFAULTS.kafka.brokers]);
  assert.equal(defaultConnection("kafka").auth.username, "");
});

test("address 换进配置时只动地址", () => {
  const kafka = withEndpoint(defaultConnection("kafka"), "10.0.0.1:9093, 10.0.0.2:9093");
  assert.equal(kafka.kind, "kafka");
  assert.deepEqual(kafka.kind === "kafka" ? kafka.brokers : [], ["10.0.0.1:9093", "10.0.0.2:9093"]);
  assert.equal(kafka.tls, "disabled");

  const rabbit = withEndpoint(defaultConnection("rabbitMq"), "rabbit:5673");
  assert.equal(rabbit.kind === "rabbitMq" ? rabbit.host : "", "rabbit");
  assert.equal(rabbit.kind === "rabbitMq" ? rabbit.port : 0, 5673);
  assert.equal(rabbit.kind === "rabbitMq" ? rabbit.auth.vhost : "", "/");
});

test("地址里没端口时沿用底子里的端口", () => {
  const config = withEndpoint(defaultConnection("rabbitMq"), "rabbit");
  assert.equal(config.kind === "rabbitMq" ? config.port : 0, 5672);
});

test("只拆「主机:端口」，拆不出来就把整段当主机", () => {
  assert.deepEqual(splitHostPort("rabbit:5673"), { host: "rabbit", port: 5673 });
  assert.deepEqual(splitHostPort("rabbit"), { host: "rabbit" });
  assert.deepEqual(splitHostPort("rabbit:"), { host: "rabbit:" });
  // IPv6 字面量不硬拆：拆错了会去连一台不存在的机器。
  assert.deepEqual(splitHostPort("[::1]:5672"), { host: "::1", port: 5672 });
  assert.deepEqual(splitHostPort("::1"), { host: "::1" });
});

test("端点措辞两种中间件各说各的", () => {
  assert.equal(endpointOf(defaultConnection("kafka")), "127.0.0.1:9092");
  assert.equal(endpointOf(defaultConnection("rabbitMq")), "127.0.0.1:5672");
});
