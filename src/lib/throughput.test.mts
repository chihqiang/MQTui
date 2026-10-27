// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

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
  assert.equal(formatThroughput(0), "静止");
  assert.equal(formatThroughput(-3), "静止");
  assert.equal(formatThroughput(Number.NaN), "静止");
  // 每秒 0.004 条显示 0.00 会被读成「停了」，所以单独说清。
  assert.equal(formatThroughput(0.004), "< 0.01 条/秒");
  assert.equal(formatThroughput(0.5), "0.50 条/秒");
  assert.equal(formatThroughput(3.1415), "3.1 条/秒");
  assert.equal(formatThroughput(1234.6), "1,235 条/秒");
});

test("窗口不可用时给出可读原因", () => {
  assert.equal(windowWarning("fresh"), undefined);
  assert.match(windowWarning("tooShort") ?? "", /采样/);
  assert.match(windowWarning("tooOld") ?? "", /30 分钟/);
  assert.match(windowWarning("invalid") ?? "", /时间顺序/);
});

test("只有正常窗口的速率才当真", () => {
  assert.equal(rateIsTrustworthy("fresh"), true);
  // 「样本旧」也算能算，但界面不能把它当即时速率展示。
  assert.equal(rateIsTrustworthy("tooOld"), false);
  assert.equal(rateIsTrustworthy("tooShort"), false);
  assert.equal(rateIsTrustworthy("invalid"), false);
});

test("静止判定要求窗口本身可用", () => {
  assert.equal(isIdle(report({ delta: 0 })), true);
  // 窗口不可用时 delta 为 0 是「算不出来」，不是「没有写入」。
  assert.equal(isIdle(report({ delta: 0, window: "invalid" })), false);
});

test("结论优先说窗口问题，其次说写入量", () => {
  assert.match(summarize(report()), /500/);
  assert.equal(summarize(report({ delta: 0 })), "窗口内没有新消息写入");
  assert.match(summarize(report({ window: "tooShort" })), /采样/);
});

test("窗口时长带小数时保留一位", () => {
  assert.equal(formatWindow(5000), "5 秒");
  assert.equal(formatWindow(2500), "2.5 秒");
});

test("最忙的分区取第一个，没有增长就没有", () => {
  assert.deepEqual(busiest(report()), { partition: 1, rate: 100 });
  assert.equal(busiest(report({ partitions: [] })), undefined);
});
