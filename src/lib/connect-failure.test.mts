/**
 * 连接失败翻译的单测。
 *
 * 这些字符串是用户唯一能看到的东西，而它们错了不会报错 —— 只会让人去改一个
 * 跟问题无关的字段。所以断言的是「指向哪一处」，不是「有没有返回」。
 */

import { expect, test } from "vitest";

import { connectFailure, connectFailureLine, type FailureField } from "./connect-failure.ts";

const payload = (message: string, kind: "connect" | "invalid" | "broker" = "connect") => ({
  kind,
  message,
});

test("端口不通指向端口，而不是地址", () => {
  // Kafka 的原文长这样：后端在前面拼了自己的前缀。
  const failure = connectFailure(
    payload("连接失败: 127.0.0.1:9092: Local: Broker transport failure: Connection refused")
  );
  expect(failure.field satisfies FailureField).toBe("port");
  expect(failure.known).toBe(true);
  // 结论里不重复后端原文的写法，说人话。
  expect(failure.summary).toMatch(/没人监听/);
  expect(failure.hint ?? "").toMatch(/9092/);
});

test("口令错了指向凭据，并且不给「改地址」的建议", () => {
  const failure = connectFailure(payload("RabbitMQ: invalid credentials"));
  expect(failure.field).toBe("auth");
  expect(failure.hint ?? "").toMatch(/vhost|口令/);
});

test("TLS 握手失败不背锅给凭据", () => {
  // 踩过的坑：SSL 错误里常带 access 字样，先匹配凭据就会把人送去改口令。
  const failure = connectFailure(payload("Kafka: SSL handshake failed: certificate verify failed"));
  expect(failure.field).toBe("tls");
});

test("后端说是参数问题就直接说是参数问题", () => {
  const failure = connectFailure(payload("Bootstrap Servers 不能为空", "invalid"));
  expect(failure.known).toBe(true);
  expect(failure.field).toBe(null);
  expect(failure.summary).toMatch(/参数/);
});

test("认不出来的错误不硬编结论，原文顶上", () => {
  const failure = connectFailure(payload("something nobody wrote a rule for"), "127.0.0.1:9092");
  expect(failure.known).toBe(false);
  expect(failure.hint).toBe(null);
  expect(failure.summary).toMatch(/127\.0\.0\.1:9092/);
  expect(failure.detail).toBe("something nobody wrote a rule for");
});

test("toast 一句话：有建议时给建议，没有时给原文", () => {
  expect(connectFailureLine(payload("Connection refused"))).toMatch(/—— /);
  expect(connectFailureLine(payload("奇怪的问题"))).toMatch(/：奇怪的问题/);
});
