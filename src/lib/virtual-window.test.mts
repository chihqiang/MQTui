import { expect, test } from "vitest";

import {
  computeRange,
  shouldRecomputeWindow,
  windowChanged,
  type VirtualRange,
} from "./virtual-window.ts";

const range = (patch: Partial<VirtualRange> = {}): VirtualRange => ({
  start: 0,
  end: 30,
  offsetY: 0,
  totalHeight: 3000,
  ...patch,
});

const input = (patch: Partial<Parameters<typeof computeRange>[0]> = {}) => ({
  itemCount: 1000,
  itemHeight: 34,
  scrollTop: 0,
  viewportHeight: 600,
  overscan: 8,
  ...patch,
});

test("可见区间按行高换算，起点前留 overscan", () => {
  // 340/34 = 10 行，起点往回退 8 行。
  const result = computeRange(input({ scrollTop: 340 }));
  expect(result.start).toBe(2);
  expect(result.offsetY).toBe(2 * 34);
  // 一屏 18 行，前后各留 8 行。
  expect(result.end).toBe(2 + Math.ceil(600 / 34) + 16);
});

test("滚到同一行之内，区间不变", () => {
  // 关键场景：一帧里滚动 3px（行高 34），可见行没换，列表不该重渲染。
  const before = computeRange(input({ scrollTop: 100 }));
  const after = computeRange(input({ scrollTop: 103 }));
  expect(before).toEqual(after);
  expect(windowChanged(before, after)).toBe(false);
});

test("跨过一行时区间才变", () => {
  // 顶部两屏都被 overscan 夹在 0，看不出差别；从第 10 行往后比较才有意义。
  const before = computeRange(input({ scrollTop: 340 }));
  const after = computeRange(input({ scrollTop: 374 }));
  expect(windowChanged(before, after)).toBe(true);
});

test("位移变化本身不算变化：它由滚动处理器直接改 transform", () => {
  const before = range({ offsetY: 0 });
  const after = range({ offsetY: 68 });
  expect(shouldRecomputeWindow(before, after)).toBe(false);
});

test("行数变化会改总高度，必须重算", () => {
  const before = range({ totalHeight: 3000 });
  const after = range({ totalHeight: 4000 });
  expect(shouldRecomputeWindow(before, after)).toBe(true);
});

test("空列表不产生偏移与高度", () => {
  expect(computeRange(input({ itemCount: 0 }))).toEqual({
    start: 0,
    end: 0,
    offsetY: 0,
    totalHeight: 0,
  });
});

test("滚到底部时不停在末尾的空白上", () => {
  // 34000 高、视口 600：滚到 33000 时还剩最后 1000px，不该「什么都没画」。
  const result = computeRange(input({ scrollTop: 33_000 }));
  expect(result.start < result.end).toBeTruthy();
  expect(result.end > 1000 - Math.ceil(600 / 34)).toBeTruthy();
});
