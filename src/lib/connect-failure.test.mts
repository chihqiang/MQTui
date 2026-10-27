/**
 * 连接失败翻译的单测。
 *
 * 这些字符串是用户唯一能看到的东西，而它们错了不会报错 —— 只会让人去改一个
 * 跟问题无关的字段。所以断言的是「指向哪一处」，不是「有没有返回」。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { connectFailure, connectFailureLine, type FailureField } from "./connect-failure.ts";

const payload = (message: string, kind: "connect" | "invalid" | "broker" = "connect") => ({
  kind,
  message,
});

test("端口不通指向端口，而不是地址", () => {
  // Kafka 的原文长这样：后端在前面拼了自己的前缀。
  const failure = connectFailure(
    payload("连接失败: 127.0.0.1:9092: Local: Broker transport failure: Connection refused"),
  );
  assert.equal(failure.field satisfies FailureField, "port");
  assert.equal(failure.known, true);
  // 结论里不重复后端原文的写法，说人话。
  assert.match(failure.summary, /没人监听/);
  assert.match(failure.hint ?? "", /9092/);
});

test("口令错了指向凭据，并且不给「改地址」的建议", () => {
  const failure = connectFailure(payload("RabbitMQ: invalid credentials"));
  assert.equal(failure.field, "auth");
  assert.match(failure.hint ?? "", /vhost|口令/);
});

test("TLS 握手失败不背锅给凭据", () => {
  // 踩过的坑：SSL 错误里常带 access 字样，先匹配凭据就会把人送去改口令。
  const failure = connectFailure(payload("Kafka: SSL handshake failed: certificate verify failed"));
  assert.equal(failure.field, "tls");
});

test("后端说是参数问题就直接说是参数问题", () => {
  const failure = connectFailure(payload("Bootstrap Servers 不能为空", "invalid"));
  assert.equal(failure.known, true);
  assert.equal(failure.field, null);
  assert.match(failure.summary, /参数/);
});

test("认不出来的错误不硬编结论，原文顶上", () => {
  const failure = connectFailure(payload("something nobody wrote a rule for"), "127.0.0.1:9092");
  assert.equal(failure.known, false);
  assert.equal(failure.hint, null);
  assert.match(failure.summary, /127\.0\.0\.1:9092/);
  assert.equal(failure.detail, "something nobody wrote a rule for");
});

test("toast 一句话：有建议时给建议，没有时给原文", () => {
  assert.match(connectFailureLine(payload("Connection refused")), /—— /);
  assert.match(connectFailureLine(payload("奇怪的问题")), /：奇怪的问题/);
});
