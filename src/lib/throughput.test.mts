import { expect, test } from "vitest";

import {
  busiest,
  formatThroughput,
  formatWindow,
  isIdle,
  rateIsTrustworthy,
  summarize,
  windowWarning,
} from "./throughput.ts";
import type { TopicThroughput } from "../types/topic-throughput.ts";

function report(patch: Partial<TopicThroughput> = {}): TopicThroughput {
  return {
    topic: "orders",
    windowMs: 5000,
    window: "fresh",
    messages: 1000,
    delta: 500,
    rate: 100,
    partitions: [{ partition: 1, messages: 800, delta: 500, rate: 100 }],
    ...patch,
  };
}

test("速率文案区分静止、微量与正常量", () => {
  expect(formatThroughput(0)).toBe("静止");
  expect(formatThroughput(-3)).toBe("静止");
  expect(formatThroughput(Number.NaN)).toBe("静止");
  // 每秒 0.004 条显示 0.00 会被读成「停了」，所以单独说清。
  expect(formatThroughput(0.004)).toBe("< 0.01 条/秒");
  expect(formatThroughput(0.5)).toBe("0.50 条/秒");
  expect(formatThroughput(3.1415)).toBe("3.1 条/秒");
  expect(formatThroughput(1234.6)).toBe("1,235 条/秒");
});

test("窗口不可用时给出可读原因", () => {
  expect(windowWarning("fresh")).toBe(undefined);
  expect(windowWarning("tooShort") ?? "").toMatch(/采样/);
  expect(windowWarning("tooOld") ?? "").toMatch(/30 分钟/);
  expect(windowWarning("invalid") ?? "").toMatch(/时间顺序/);
});

test("只有正常窗口的速率才当真", () => {
  expect(rateIsTrustworthy("fresh")).toBe(true);
  // 「样本旧」也算能算，但界面不能把它当即时速率展示。
  expect(rateIsTrustworthy("tooOld")).toBe(false);
  expect(rateIsTrustworthy("tooShort")).toBe(false);
  expect(rateIsTrustworthy("invalid")).toBe(false);
});

test("静止判定要求窗口本身可用", () => {
  expect(isIdle(report({ delta: 0 }))).toBe(true);
  // 窗口不可用时 delta 为 0 是「算不出来」，不是「没有写入」。
  expect(isIdle(report({ delta: 0, window: "invalid" }))).toBe(false);
});

test("结论优先说窗口问题，其次说写入量", () => {
  expect(summarize(report())).toMatch(/500/);
  expect(summarize(report({ delta: 0 }))).toBe("窗口内没有新消息写入");
  expect(summarize(report({ window: "tooShort" }))).toMatch(/采样/);
});

test("窗口时长带小数时保留一位", () => {
  expect(formatWindow(5000)).toBe("5 秒");
  expect(formatWindow(2500)).toBe("2.5 秒");
});

test("最忙的分区取第一个，没有增长就没有", () => {
  expect(busiest(report())).toEqual({ partition: 1, rate: 100 });
  expect(busiest(report({ partitions: [] }))).toBe(undefined);
});
