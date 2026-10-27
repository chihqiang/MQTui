import { expect, test } from "vitest";

import {
  RETENTION_KEY,
  describeRetention,
  describeRetentionPlan,
  parseRetentionMs,
  retentionChanges,
  retentionIssue,
  summarizeRetention,
} from "./retention.ts";

test("选了档位就直接用它", () => {
  expect(parseRetentionMs({ action: { kind: "set", ms: 3600000 }, custom: "" })).toBe(3600000);
  expect(retentionIssue({ action: { kind: "set", ms: -1 }, custom: "" })).toBe(null);
});

test("手填的值优先于档位", () => {
  expect(parseRetentionMs({ action: { kind: "set", ms: 3600000 }, custom: "1234" })).toBe(1234);
});

test("0 与小于 -1 的值都不接受", () => {
  expect(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "0" })).toBe(null);
  expect(retentionIssue({ action: { kind: "set", ms: 1 }, custom: "0" })).toBeTruthy();
  expect(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "-2" })).toBe(null);
  expect(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "-1" })).toBe(-1);
});

test("非整数输入给出可读原因", () => {
  expect(retentionIssue({ action: { kind: "set", ms: 1 }, custom: "7d" })).toBeTruthy();
  expect(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "1.5" })).toBe(null);
  expect(retentionIssue({ action: { kind: "clear" }, custom: "" })).toBe(null);
});

test("批量变更按主题数展开，键名固定", () => {
  const changes = retentionChanges(["a", "b"], { action: { kind: "set", ms: 604800000 }, custom: "" });
  expect(changes.length).toBe(2);
  expect(changes[0]).toEqual({ key: RETENTION_KEY, value: "604800000" });
  expect(retentionChanges([], { action: { kind: "set", ms: 1 }, custom: "" })).toEqual([]);
  expect(retentionChanges(["a"], { action: { kind: "set", ms: 1 }, custom: "0" })).toEqual([]);
});

test("毫秒转人话", () => {
  expect(describeRetention(-1)).toBe("永久（-1）");
  expect(describeRetention(604800000)).toBe("7 天");
  expect(describeRetention(7200000)).toBe("2 小时");
  expect(describeRetention(1500)).toBe("1500 毫秒");
});

test("确认文案点名主题数与后果，并提到被跳过的内部主题", () => {
  const lines = describeRetentionPlan({
    targets: ["a", "b"],
    input: { action: { kind: "set", ms: 604800000 }, custom: "" },
    skipped: ["__consumer_offsets"],
  });
  expect(lines[0]).toMatch(/2 个主题/);
  expect(lines[0]).toMatch(/7 天/);
  expect(lines.some((line) => line.includes("__consumer_offsets"))).toBeTruthy();
  expect(lines.some((line) => line.includes("不会回滚"))).toBeTruthy();
});

test("结果汇总把失败的主题名字摆出来", () => {
  const ok = summarizeRetention([
    { topic: "a", ok: true, detail: "" },
    { topic: "b", ok: true, detail: "" },
  ]);
  expect(ok.failed).toBe(0);
  expect(ok.text).toBe("已更新 2 个主题的保留时长");

  const mixed = summarizeRetention([
    { topic: "a", ok: true, detail: "" },
    { topic: "b", ok: false, detail: "not authorized" },
  ]);
  expect(mixed.ok).toBe(1);
  expect(mixed.failed).toBe(1);
  expect(mixed.text).toMatch(/b（not authorized）/);
});
