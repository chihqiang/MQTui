/**
 * 管理 API 地址的自动填充规则。
 *
 * 盯住三件事：跟着 Host 走、手填的不被覆盖、清空后能重新跟着走。
 * 第三条最容易写坏 —— 空串既不是「没填过」也不是「一个地址」，含糊过去就成了
 * 「改完 Host，面板跑去问上一台机器要队列列表」。
 */

import { expect, test } from "vitest";

import {
  followManagementUrl,
  managementUrlFor,
  withManagementUrl,
} from "./management-url.ts";

test("按 Host 推管理地址，TLS 换端口", () => {
  expect(managementUrlFor("mq.example.com", false)).toBe("http://mq.example.com:15672");
  expect(managementUrlFor("mq.example.com", true)).toBe("https://mq.example.com:15671");
  expect(managementUrlFor("  10.0.0.1  ", false)).toBe("http://10.0.0.1:15672");
  // Host 空着时无话可说，不要造一个 http://:15672。
  expect(managementUrlFor("  ", false)).toBe("");
});

test("改 Host 时自动填的那一格跟着走", () => {
  expect(followManagementUrl("http://old:15672", "old", false, "new", false)).toBe("http://new:15672");
  // 上一次是自动填的，这一次换成 TLS：端口也跟着换。
  expect(followManagementUrl("http://old:15672", "old", false, "old", true)).toBe("https://old:15671");
});

test("空着也当作自动填，直接跟上", () => {
  expect(followManagementUrl(undefined, "old", false, "new", false)).toBe("http://new:15672");
  expect(followManagementUrl("  ", "old", false, "new", false)).toBe("http://new:15672");
});

test("手填的地址不会被 Host 覆盖", () => {
  // 反代、跳板、非默认端口都在这一种里：用户知道得比我们多。
  expect(followManagementUrl("https://mq.internal/api", "old", false, "new", false)).toBe("https://mq.internal/api");
});

test("手填的地址被清空后，下一次改 Host 就接回来", () => {
  // 空串是「留空」，不是「手填的地址」：再改 Host 时它该重新跟上。
  expect(followManagementUrl("", "old", false, "new", true)).toBe("https://new:15671");
});

test("提交前补齐空着的那一格，显式空串保持不动", () => {
  const empty: { host: string; managementUrl?: string } = { host: "mq" };
  expect(withManagementUrl(empty, "http://mq:15672")).toEqual({
    host: "mq",
    managementUrl: "http://mq:15672",
  });
  // 空串是「我不用管理插件」，别替人改主意。
  expect(withManagementUrl({ host: "mq", managementUrl: "" }, "http://mq:15672")).toEqual({
    host: "mq",
    managementUrl: "",
  });
  expect(withManagementUrl({ host: "mq", managementUrl: "https://x" }, "http://mq:15672")).toEqual({ host: "mq", managementUrl: "https://x" });
});
