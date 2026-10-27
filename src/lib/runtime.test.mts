/**
 * 运行时页展示逻辑的单测。
 *
 * 这里盯的是「哪些行会变红」：预取打满必须红，空转只能是黄，
 * 连接进入 blocking 必须红 —— 这三种状态在排查时的含义完全不同。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  channelIdle,
  channelSaturated,
  channelTone,
  connectionHasProblem,
  connectionTone,
  describeRuntime,
  matchConnection,
} from "./runtime.ts";

function channel(overrides = {}) {
  return {
    name: "10.0.0.1:1 -> 10.0.0.2:5672 (1)",
    connection: "conn-1",
    user: "app",
    consumers: 1,
    prefetch: 10,
    unacked: 0,
    acks: 5,
    ...overrides,
  };
}

function connection(overrides = {}) {
  return {
    name: "conn-1",
    clientName: "order-service",
    user: "app",
    peerHost: "10.0.0.9",
    peerPort: 51000,
    channels: 1,
    state: "running",
    recvRate: 0,
    sendRate: 0,
    ...overrides,
  };
}

test("预取 0 表示不限，永远不算打满", () => {
  assert.equal(channelSaturated(channel({ prefetch: 0, unacked: 999 })), false);
});

test("未确认数触到预取上限即为打满", () => {
  assert.equal(channelSaturated(channel({ prefetch: 10, unacked: 10 })), true);
});

test("打满的通道是 danger", () => {
  assert.equal(channelTone(channel({ unacked: 10 })), "danger");
});

test("空转通道是 warning 而不是 danger", () => {
  const idle = channel({ consumers: 0, acks: 0, unacked: 0 });
  assert.equal(channelIdle(idle), true);
  assert.equal(channelTone(idle), "warning");
});

test("正常通道保持中性", () => {
  assert.equal(channelTone(channel()), "neutral");
});

test("blocking 状态的连接是 danger", () => {
  assert.equal(connectionTone(connection({ state: "blocking" })), "danger");
  assert.equal(connectionTone(connection()), "success");
});

test("关键字能匹配客户端名与对端地址", () => {
  const detail = { connection: connection(), channels: [], unackedTotal: 0, saturated: 0 };
  assert.equal(matchConnection(detail, "order"), true);
  assert.equal(matchConnection(detail, "10.0.0.9"), true);
  assert.equal(matchConnection(detail, "missing"), false);
  assert.equal(matchConnection(detail, "  "), true);
});

test("连接只要有一个打满通道就算有问题", () => {
  const detail = {
    connection: connection(),
    channels: [channel({ unacked: 10 })],
    unackedTotal: 10,
    saturated: 1,
  };
  assert.equal(connectionHasProblem(detail), true);
});

test("总结里优先报告卡住的连接", () => {
  const snapshot = {
    connections: [
      {
        connection: connection(),
        channels: [channel({ unacked: 10 })],
        unackedTotal: 10,
        saturated: 1,
      },
    ],
    queues: [],
    unassigned: ["lonely"],
    perNode: {},
  };
  assert.match(describeRuntime(snapshot), /1 条连接有卡住的通道/);
});
