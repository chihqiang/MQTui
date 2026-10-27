/**
 * 单页条数解析的单测。
 *
 * 这几条错了都不会崩：请求照发、页面照显示，只是前端以为拿到的条数和
 * 后端真正返回的不是同一个数 —— 后者会让「还有下一页」的判断错位。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  isPageSize,
  resolvePageSize,
} from "./page-size.ts";

test("缺值与脏值回落到默认条数", () => {
  // 老版本数据里没有 pageSize；手改 localStorage 还能塞进任何东西。
  assert.equal(resolvePageSize(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(null), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(Number.NaN), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize("200"), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(0), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(-5), DEFAULT_PAGE_SIZE);
  assert.equal(resolvePageSize(2.5), DEFAULT_PAGE_SIZE);
});

test("合法值原样返回", () => {
  assert.equal(resolvePageSize(50), 50);
  assert.equal(resolvePageSize(200), 200);
});

test("超过后端上限一律夹到上限", () => {
  // 后端 `clamp_limit` 会砍到 500，前端若以为自己拿到了 5000 条就会算错。
  assert.equal(resolvePageSize(5000), MAX_PAGE_SIZE);
  assert.equal(resolvePageSize(MAX_PAGE_SIZE), MAX_PAGE_SIZE);
});

test("默认条数本身必须是合法值", () => {
  assert.ok(isPageSize(DEFAULT_PAGE_SIZE));
  // 默认值走一遍解析必须原样返回：默认值自己不能被夹紧改掉。
  assert.equal(resolvePageSize(DEFAULT_PAGE_SIZE), DEFAULT_PAGE_SIZE);
});
