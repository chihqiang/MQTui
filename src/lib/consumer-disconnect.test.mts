/**
 * 断开判定与后端 `domain/consumer_disconnect.rs` 的用例逐条对照。
 *
 * 两边各写一份规则是为了「渲染阶段就能决定按钮状态」，代价是可能漂移。
 * 这组断言就是那道防线：后端改了规则，这里会立刻红。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { confirmMatches, evaluateDisconnect } from "./consumer-disconnect.ts";

function consumer(tag: string, unacked = 0) {
  return {
    queue: "orders",
    consumerTag: tag,
    username: "app",
    ackRequired: true,
    prefetchCount: 10,
    messagesUnacknowledged: unacked,
  };
}

test("空闲消费者可以断开", () => {
  assert.equal(evaluateDisconnect(consumer("amq.ctag-abc123")), "allowed");
});

test("有未确认消息就拦下", () => {
  assert.equal(evaluateDisconnect(consumer("amq.ctag-abc123", 1)), "inFlight");
});

test("面板自己的消费者不能被断开", () => {
  assert.equal(evaluateDisconnect(consumer("mqtui-preview-42")), "ownedByPanel");
});

test("不可定位的 tag 一律拒绝", () => {
  assert.equal(evaluateDisconnect(consumer("   ")), "unknownTarget");
  assert.equal(evaluateDisconnect(consumer("amq.ctag/a")), "unknownTarget");
  assert.equal(evaluateDisconnect(consumer("amq.ctag-\u0001")), "unknownTarget");
});

test("确认串必须与队列名一致", () => {
  assert.ok(confirmMatches("orders", "orders"));
  assert.ok(confirmMatches("orders", " orders "));
  assert.equal(confirmMatches("orders", "order"), false);
  assert.equal(confirmMatches("orders", ""), false);
  // 队列名为空时永远不能通过：那等于没确认。
  assert.equal(confirmMatches("  ", "  "), false);
});
