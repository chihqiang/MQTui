/**
 * 展示层格式化的单测。
 *
 * 这几个函数看起来「怎么写都对」，但写错时界面照样能跑 —— 只是把
 * 「这个盘还剩 2 TB」显示成「2048.0 GB」，或者把未知值显示成 0。
 * 所以断言的是**具体文案**，不是「返回值非空」。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { formatBytes, formatNumber } from "./format.ts";

test("字节数按 1024 进制换单位", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 ** 2), "3.0 MB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GB");
});

test("超过 1 TB 不再退回 GB", () => {
  // 回归：单位表只排到 GB 时，一块 2 TB 的盘会显示成「2048.0 GB」。
  assert.equal(formatBytes(2 * 1024 ** 4), "2.0 TB");
  assert.equal(formatBytes(2 * 1024 ** 4 + 512 * 1024 ** 3), "2.5 TB");
});

test("负数与未知值不伪装成 0", () => {
  // 负余量显示成「-1.0 B 可用」比「-」更容易被当真。
  assert.equal(formatBytes(undefined), "-");
  assert.equal(formatBytes(Number.NaN), "-");
  assert.equal(formatBytes(-1), "-");
});

test("数字千分位，未知值给横线", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(undefined), "-");
  assert.equal(formatNumber(Number.NaN), "-");
});
