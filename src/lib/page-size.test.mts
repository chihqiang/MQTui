/**
 * 单页条数解析的单测。
 *
 * 这几条错了都不会崩：请求照发、页面照显示，只是前端以为拿到的条数和
 * 后端真正返回的不是同一个数 —— 后者会让「还有下一页」的判断错位。
 */

import { expect, test } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  isPageSize,
  resolvePageSize,
} from "./page-size.ts";

test("缺值与脏值回落到默认条数", () => {
  // 老版本数据里没有 pageSize；手改 localStorage 还能塞进任何东西。
  expect(resolvePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  expect(resolvePageSize(null)).toBe(DEFAULT_PAGE_SIZE);
  expect(resolvePageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  expect(resolvePageSize("200")).toBe(DEFAULT_PAGE_SIZE);
  expect(resolvePageSize(0)).toBe(DEFAULT_PAGE_SIZE);
  expect(resolvePageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
  expect(resolvePageSize(2.5)).toBe(DEFAULT_PAGE_SIZE);
});

test("合法值原样返回", () => {
  expect(resolvePageSize(50)).toBe(50);
  expect(resolvePageSize(200)).toBe(200);
});

test("超过后端上限一律夹到上限", () => {
  // 后端 `clamp_limit` 会砍到 500，前端若以为自己拿到了 5000 条就会算错。
  expect(resolvePageSize(5000)).toBe(MAX_PAGE_SIZE);
  expect(resolvePageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
});

test("默认条数本身必须是合法值", () => {
  expect(isPageSize(DEFAULT_PAGE_SIZE)).toBeTruthy();
  // 默认值走一遍解析必须原样返回：默认值自己不能被夹紧改掉。
  expect(resolvePageSize(DEFAULT_PAGE_SIZE)).toBe(DEFAULT_PAGE_SIZE);
});
