/**
 * 铲子运行态判读的测试。
 *
 * 这几条错了都不会崩，只会让人读错结论 —— 而「读错结论」正是这一屏要防的事。
 */

import { expect, test } from "vitest";

import {
  attentionCount,
  needsAttention,
  stateLabel,
  stateTone,
  stopHint,
  summarize,
  transferredText,
} from "./shovel.ts";
import type { ShovelRow, ShovelRuntime } from "../types/shovel.ts";

function runtime(overrides: Partial<ShovelRuntime> = {}): ShovelRuntime {
  return {
    name: "sh1",
    vhost: "/",
    state: "running",
    kind: "static",
    reason: "",
    srcUri: "amqp://a:5672",
    destUri: "amqp://b:5672",
    messagesTransferred: 12,
    ...overrides,
  };
}

function row(overrides: Partial<ShovelRow> = {}): ShovelRow {
  return {
    name: "sh1",
    vhost: "/",
    config: null,
    runtime: runtime(),
    problem: "",
    foreign: false,
    ...overrides,
  };
}

test("没有运行态时不报「已停止」", () => {
  expect(stateLabel(row({ runtime: null })), "「不知道」不能说成「停了」").toBe("无运行态");
});

test("三态各有中文名", () => {
  expect(stateLabel(row({ runtime: runtime({ state: "running" }) }))).toBe("运行中");
  expect(stateLabel(row({ runtime: runtime({ state: "starting" }) }))).toBe("启动中");
  expect(stateLabel(row({ runtime: runtime({ state: "terminated" }) }))).toBe("已停止");
});

test("已停止用危险色，启动中用提醒色，没有运行态用中性色", () => {
  expect(stateTone(row({ runtime: runtime({ state: "terminated" }) }))).toBe("danger");
  expect(stateTone(row({ runtime: runtime({ state: "starting" }) }))).toBe("warning");
  expect(stateTone(row({ runtime: null }))).toBe("neutral");
});

test("启动中不算需要关注：可能只是刚起，标红会让人白查一轮", () => {
  expect(needsAttention(row({ runtime: runtime({ state: "starting" }) }))).toBe(false);
});

test("已停止、以及后端给出问题的行都要关注", () => {
  expect(needsAttention(row({ runtime: runtime({ state: "terminated" }) }))).toBe(true);
  expect(needsAttention(row({ problem: "插件可能未启用" })), "有问题的行即使状态正常也要关注").toBe(
    true,
  );
});

test("零条要单说，不能显示成 0 条", () => {
  expect(transferredText(row({ runtime: runtime({ messagesTransferred: 0 }) }))).toBe(
    "一条都没搬过",
  );
  expect(transferredText(row({ runtime: null })), "没有运行态时不编数字").toBe("—");
});

test("动态与静态铲子的停止后果不同，不能共用一句话", () => {
  expect(stopHint(row({ runtime: runtime({ kind: "dynamic" }) }))).toContain("不会自己回来");
  expect(stopHint(row({ runtime: runtime({ kind: "static" }) }))).toContain("重启后");
});

test("读不到运行态与「一条都没有」分开说", () => {
  expect(summarize({ rows: [], runtimeError: "404" })).toBe("读不到铲子运行态");
  expect(summarize({ rows: [], runtimeError: null })).toBe("这个 vhost 没有铲子");
});

test("配置都在但看不到运行态时不能说「全部正常」", () => {
  expect(summarize({ rows: [row()], runtimeError: "403" }), "接口失败不等于一切正常").toBe(
    "配置都在，但看不到运行态",
  );
});

test("有问题时先报问题数", () => {
  const broken = row({ runtime: runtime({ state: "terminated" }) });
  expect(summarize({ rows: [broken], runtimeError: "403" })).toBe("1 条需要看一眼");
  expect(summarize({ rows: [row()], runtimeError: null })).toBe("全部正常");
  expect(attentionCount({ rows: [row(), broken], runtimeError: null })).toBe(1);
});
