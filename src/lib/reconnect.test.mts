// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { canReconnect, disconnectLabel, isEntryBusy, reconnectLabel } from "./reconnect.ts";

test("只有被点的那一条算忙碌", () => {
  assert.equal(isEntryBusy("a", "a"), true);
  assert.equal(isEntryBusy("a", "b"), false);
  assert.equal(isEntryBusy("a", null), false);
});

test("有用户名没口令的连接不该给「重连」", () => {
  assert.equal(canReconnect({ config: { auth: { username: "app", password: "x" } } }), true);
  assert.equal(canReconnect({ config: { auth: { username: "app", password: "" } } }), false);
  assert.equal(canReconnect({ config: { auth: { username: "  ", password: "" } } }), true);
  assert.equal(canReconnect({ config: { auth: {} } }), true);
});

test("忙碌时文案说明是哪一条在连", () => {
  assert.equal(reconnectLabel("kafka-prod", true), "正在连接 kafka-prod");
  assert.equal(reconnectLabel("kafka-prod", false), "重连");
});

test("断开时同样说明断的是哪一条", () => {
  assert.equal(disconnectLabel("kafka-prod", false), "断开 kafka-prod");
  assert.equal(disconnectLabel("kafka-prod", true), "正在断开 kafka-prod");
});
