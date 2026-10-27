// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

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
  assert.equal(result.start, 2);
  assert.equal(result.offsetY, 2 * 34);
  // 一屏 18 行，前后各留 8 行。
  assert.equal(result.end, 2 + Math.ceil(600 / 34) + 16);
});

test("滚到同一行之内，区间不变", () => {
  // 关键场景：一帧里滚动 3px（行高 34），可见行没换，列表不该重渲染。
  const before = computeRange(input({ scrollTop: 100 }));
  const after = computeRange(input({ scrollTop: 103 }));
  assert.deepEqual(before, after);
  assert.equal(windowChanged(before, after), false);
});

test("跨过一行时区间才变", () => {
  // 顶部两屏都被 overscan 夹在 0，看不出差别；从第 10 行往后比较才有意义。
  const before = computeRange(input({ scrollTop: 340 }));
  const after = computeRange(input({ scrollTop: 374 }));
  assert.equal(windowChanged(before, after), true);
});

test("位移变化本身不算变化：它由滚动处理器直接改 transform", () => {
  const before = range({ offsetY: 0 });
  const after = range({ offsetY: 68 });
  assert.equal(shouldRecomputeWindow(before, after), false);
});

test("行数变化会改总高度，必须重算", () => {
  const before = range({ totalHeight: 3000 });
  const after = range({ totalHeight: 4000 });
  assert.equal(shouldRecomputeWindow(before, after), true);
});

test("空列表不产生偏移与高度", () => {
  assert.deepEqual(computeRange(input({ itemCount: 0 })), {
    start: 0,
    end: 0,
    offsetY: 0,
    totalHeight: 0,
  });
});

test("滚到底部时不停在末尾的空白上", () => {
  // 34000 高、视口 600：滚到 33000 时还剩最后 1000px，不该「什么都没画」。
  const result = computeRange(input({ scrollTop: 33_000 }));
  assert.ok(result.start < result.end, "区间不能是空的");
  assert.ok(result.end > 1000 - Math.ceil(600 / 34), "末尾的可见行必须画出来");
});
