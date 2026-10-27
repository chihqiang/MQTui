/**
 * 管理 API 地址的自动填充规则。
 *
 * 盯住三件事：跟着 Host 走、手填的不被覆盖、清空后能重新跟着走。
 * 第三条最容易写坏 —— 空串既不是「没填过」也不是「一个地址」，含糊过去就成了
 * 「改完 Host，面板跑去问上一台机器要队列列表」。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  followManagementUrl,
  managementUrlFor,
  withManagementUrl,
} from "./management-url.ts";

test("按 Host 推管理地址，TLS 换端口", () => {
  assert.equal(managementUrlFor("mq.example.com", false), "http://mq.example.com:15672");
  assert.equal(managementUrlFor("mq.example.com", true), "https://mq.example.com:15671");
  assert.equal(managementUrlFor("  10.0.0.1  ", false), "http://10.0.0.1:15672");
  // Host 空着时无话可说，不要造一个 http://:15672。
  assert.equal(managementUrlFor("  ", false), "");
});

test("改 Host 时自动填的那一格跟着走", () => {
  assert.equal(
    followManagementUrl("http://old:15672", "old", false, "new", false),
    "http://new:15672",
  );
  // 上一次是自动填的，这一次换成 TLS：端口也跟着换。
  assert.equal(
    followManagementUrl("http://old:15672", "old", false, "old", true),
    "https://old:15671",
  );
});

test("空着也当作自动填，直接跟上", () => {
  assert.equal(followManagementUrl(undefined, "old", false, "new", false), "http://new:15672");
  assert.equal(followManagementUrl("  ", "old", false, "new", false), "http://new:15672");
});

test("手填的地址不会被 Host 覆盖", () => {
  // 反代、跳板、非默认端口都在这一种里：用户知道得比我们多。
  assert.equal(
    followManagementUrl("https://mq.internal/api", "old", false, "new", false),
    "https://mq.internal/api",
  );
});

test("手填的地址被清空后，下一次改 Host 就接回来", () => {
  // 空串是「留空」，不是「手填的地址」：再改 Host 时它该重新跟上。
  assert.equal(followManagementUrl("", "old", false, "new", true), "https://new:15671");
});

test("提交前补齐空着的那一格，显式空串保持不动", () => {
  const empty: { host: string; managementUrl?: string } = { host: "mq" };
  assert.deepEqual(withManagementUrl(empty, "http://mq:15672"), {
    host: "mq",
    managementUrl: "http://mq:15672",
  });
  // 空串是「我不用管理插件」，别替人改主意。
  assert.deepEqual(withManagementUrl({ host: "mq", managementUrl: "" }, "http://mq:15672"), {
    host: "mq",
    managementUrl: "",
  });
  assert.deepEqual(
    withManagementUrl({ host: "mq", managementUrl: "https://x" }, "http://mq:15672"),
    { host: "mq", managementUrl: "https://x" },
  );
});
