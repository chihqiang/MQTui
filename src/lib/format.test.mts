/**
 * 展示层格式化的单测。
 *
 * 这几个函数看起来「怎么写都对」，但写错时界面照样能跑 —— 只是把
 * 「这个盘还剩 2 TB」显示成「2048.0 GB」，或者把未知值显示成 0。
 * 所以断言的是**具体文案**，不是「返回值非空」。
 */

import { expect, test } from "vitest";

import { formatBytes, formatNumber } from "./format.ts";

test("字节数按 1024 进制换单位", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
  expect(formatBytes(3 * 1024 ** 2)).toBe("3.0 MB");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
});

test("超过 1 TB 不再退回 GB", () => {
  // 回归：单位表只排到 GB 时，一块 2 TB 的盘会显示成「2048.0 GB」。
  expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  expect(formatBytes(2 * 1024 ** 4 + 512 * 1024 ** 3)).toBe("2.5 TB");
});

test("负数与未知值不伪装成 0", () => {
  // 负余量显示成「-1.0 B 可用」比「-」更容易被当真。
  expect(formatBytes(undefined)).toBe("-");
  expect(formatBytes(Number.NaN)).toBe("-");
  expect(formatBytes(-1)).toBe("-");
});

test("数字千分位，未知值给横线", () => {
  expect(formatNumber(1234567)).toBe("1,234,567");
  expect(formatNumber(undefined)).toBe("-");
  expect(formatNumber(Number.NaN)).toBe("-");
});
