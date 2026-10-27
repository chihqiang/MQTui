/**
 * 滚动位置记忆的单测。
 *
 * 这几条都是「不报错但很难受」的规则：顶部被记下来、越界值没夹住、
 * 无谓赋值触发一轮重算 —— 界面上什么都看不出来。
 */

import { expect, test } from "vitest";

import { clampScrollTop, isRestorable, restoreMoved } from "./scroll-restore.ts";

test("顶部位置不记忆", () => {
  expect(isRestorable(0)).toBe(false);
  expect(isRestorable(0.4)).toBe(false);
  expect(isRestorable(120)).toBe(true);
});

test("容器未布局时读到的脏值不算可记忆位置", () => {
  expect(isRestorable(Number.NaN)).toBe(false);
  expect(isRestorable(Number.POSITIVE_INFINITY)).toBe(false);
  expect(isRestorable(-40)).toBe(false);
});

test("恢复位置不超过可滚动上限", () => {
  // 内容 3400、视口 600 → 上限 2800，记下的 5000 必须被夹住。
  expect(clampScrollTop(5000, 3400, 600)).toBe(2800);
  expect(clampScrollTop(1200, 3400, 600)).toBe(1200);
});

test("内容比视口还短时恢复位置为 0", () => {
  expect(clampScrollTop(300, 400, 600)).toBe(0);
});

test("脏目标位置一律归零，不把 NaN 写进 scrollTop", () => {
  expect(clampScrollTop(Number.NaN, 3400, 600)).toBe(0);
  expect(clampScrollTop(-10, 3400, 600)).toBe(0);
});

test("位置没变就别写 scrollTop", () => {
  expect(restoreMoved(0, 0)).toBe(false);
  expect(restoreMoved(120, 120.4)).toBe(false);
  expect(restoreMoved(120, 340)).toBe(true);
});
