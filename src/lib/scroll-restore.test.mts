/**
 * 滚动位置记忆的单测。
 *
 * 这几条都是「不报错但很难受」的规则：顶部被记下来、越界值没夹住、
 * 无谓赋值触发一轮重算 —— 界面上什么都看不出来。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { clampScrollTop, isRestorable, restoreMoved } from "./scroll-restore.ts";

test("顶部位置不记忆", () => {
  assert.equal(isRestorable(0), false);
  assert.equal(isRestorable(0.4), false);
  assert.equal(isRestorable(120), true);
});

test("容器未布局时读到的脏值不算可记忆位置", () => {
  assert.equal(isRestorable(Number.NaN), false);
  assert.equal(isRestorable(Number.POSITIVE_INFINITY), false);
  assert.equal(isRestorable(-40), false);
});

test("恢复位置不超过可滚动上限", () => {
  // 内容 3400、视口 600 → 上限 2800，记下的 5000 必须被夹住。
  assert.equal(clampScrollTop(5000, 3400, 600), 2800);
  assert.equal(clampScrollTop(1200, 3400, 600), 1200);
});

test("内容比视口还短时恢复位置为 0", () => {
  assert.equal(clampScrollTop(300, 400, 600), 0);
});

test("脏目标位置一律归零，不把 NaN 写进 scrollTop", () => {
  assert.equal(clampScrollTop(Number.NaN, 3400, 600), 0);
  assert.equal(clampScrollTop(-10, 3400, 600), 0);
});

test("位置没变就别写 scrollTop", () => {
  assert.equal(restoreMoved(0, 0), false);
  assert.equal(restoreMoved(120, 120.4), false);
  assert.equal(restoreMoved(120, 340), true);
});
