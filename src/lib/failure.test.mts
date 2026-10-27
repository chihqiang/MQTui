/**
 * 失败文案的单测。
 *
 * 这条规则很朴素但很容易被改坏：错误提示必须说清「哪件事、哪个对象」失败了。
 * 只有「读取失败」四个字，用户没法判断该动配置还是等网络。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { failureText, shouldReplaceWithError } from "./failure.ts";

test("带上动作与对象", () => {
  assert.equal(
    failureText("读取队列", "连接被拒绝", "orders"),
    "读取队列 orders 失败：连接被拒绝",
  );
});

test("对象名留空时不出现多余空格", () => {
  assert.equal(failureText("读取队列", "连接被拒绝"), "读取队列失败：连接被拒绝");
  assert.equal(failureText("读取队列", "连接被拒绝", "   "), "读取队列失败：连接被拒绝");
});

test("有旧数据时不用错误页顶掉内容", () => {
  assert.equal(shouldReplaceWithError({ hasData: true, isFetching: false }), false);
});

test("没有数据且不在重试时才显示错误页", () => {
  assert.equal(shouldReplaceWithError({ hasData: false, isFetching: false }), true);
  assert.equal(shouldReplaceWithError({ hasData: false, isFetching: true }), false);
});
