/**
 * 刷新行为与措辞的单测。
 *
 * 重点不是函数能跑，而是几条**必须这么显示**的规则：
 * 刷新时不能铺骨架、首屏不该叠两重提示、刷新失败不能把手上的数据清掉、
 * 过滤无命中时不能把「继续加载」藏起来。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  describeRefresh,
  keepLoadMoreVisible,
  progressBarVisible,
  refreshHintText,
  relativeTime,
  scrollResetNeeded,
} from "./refresh.ts";

test("首屏没有数据时才铺骨架", () => {
  assert.equal(describeRefresh({ firstLoad: true, refreshing: true, hasData: false }).showSkeleton, true);
  // 已有数据再刷新：骨架会让用户把同一块内容读两遍。
  assert.equal(describeRefresh({ firstLoad: false, refreshing: true, hasData: true }).showSkeleton, false);
});

test("刷新提示只在「有旧数据、且不是首屏」时出现", () => {
  assert.equal(describeRefresh({ firstLoad: true, refreshing: true, hasData: false }).showRefreshHint, false);
  assert.equal(describeRefresh({ firstLoad: false, refreshing: true, hasData: true }).showRefreshHint, true);
  assert.equal(describeRefresh({ firstLoad: false, refreshing: false, hasData: true }).showRefreshHint, false);
});

test("刷新期间旧数据继续显示", () => {
  const state = describeRefresh({ firstLoad: false, refreshing: true, hasData: true });
  assert.equal(state.keepStaleContent, true);
});

test("刚打开页面时刷新按钮旁不给文案", () => {
  assert.equal(refreshHintText({ firstLoad: true, refreshing: true, hasData: false }), null);
});

test("刷新中优先说「刷新中」，空闲时说新鲜度", () => {
  assert.equal(refreshHintText({ firstLoad: false, refreshing: true, hasData: true }), "刷新中…");
  assert.equal(refreshHintText({ firstLoad: false, refreshing: false, hasData: true }, "刚刚"), "数据更新于 刚刚");
  assert.equal(refreshHintText({ firstLoad: false, refreshing: false, hasData: true }), null);
});

test("相对时间按跨度分档，未来时间不出现负数", () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now - 2_000, now), "刚刚");
  assert.equal(relativeTime(now - 30_000, now), "30 秒前");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3 小时前");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 天前");
  assert.equal(relativeTime(now + 5_000, now), "刚刚");
});

test("换数据源要回顶部，追加不重置，过滤变少也不重置", () => {
  assert.equal(scrollResetNeeded({ sourceChanged: true, previousCount: 50, nextCount: 50 }), true);
  assert.equal(scrollResetNeeded({ sourceChanged: false, previousCount: 50, nextCount: 80 }), false);
  // 过滤把 20 条筛成 0 条：用户手还停在原地，不该被拽回顶部。
  assert.equal(scrollResetNeeded({ sourceChanged: false, previousCount: 20, nextCount: 0 }), false);
});

test("过滤无命中时继续留着加载入口", () => {
  assert.equal(keepLoadMoreVisible({ hasMore: true, visibleCount: 0 }), true);
  assert.equal(keepLoadMoreVisible({ hasMore: true, visibleCount: 3 }), false);
  assert.equal(keepLoadMoreVisible({ hasMore: false, visibleCount: 0 }), false);
});

// —— 细进度线 ————————————————————————————————————————————————

test("刷新中进度线常亮", () => {
  assert.equal(progressBarVisible({ active: true, endedAt: null, now: 0 }), true);
});

test("结束后留一个淡出窗口，不立刻抽走", () => {
  // 一次 80ms 就回来的本地刷新，线还没被看见就消失，等于没有。
  assert.equal(progressBarVisible({ active: false, endedAt: 1000, now: 1100 }), true);
  assert.equal(progressBarVisible({ active: false, endedAt: 1000, now: 1300 }), false);
});

test("从没刷新过时不画线，也不报错", () => {
  assert.equal(progressBarVisible({ active: false, endedAt: null, now: 5000 }), false);
});
