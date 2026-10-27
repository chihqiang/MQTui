/**
 * 失败文案的单测。
 *
 * 这条规则很朴素但很容易被改坏：错误提示必须说清「哪件事、哪个对象」失败了。
 * 只有「读取失败」四个字，用户没法判断该动配置还是等网络。
 */

import { expect, test } from "vitest";

import { failureText, shouldReplaceWithError } from "./failure.ts";

test("带上动作与对象", () => {
  expect(failureText("读取队列", "连接被拒绝", "orders")).toBe("读取队列 orders 失败：连接被拒绝");
});

test("对象名留空时不出现多余空格", () => {
  expect(failureText("读取队列", "连接被拒绝")).toBe("读取队列失败：连接被拒绝");
  expect(failureText("读取队列", "连接被拒绝", "   ")).toBe("读取队列失败：连接被拒绝");
});

test("有旧数据时不用错误页顶掉内容", () => {
  expect(shouldReplaceWithError({ hasData: true, isFetching: false })).toBe(false);
});

test("没有数据且不在重试时才显示错误页", () => {
  expect(shouldReplaceWithError({ hasData: false, isFetching: false })).toBe(true);
  expect(shouldReplaceWithError({ hasData: false, isFetching: true })).toBe(false);
});
