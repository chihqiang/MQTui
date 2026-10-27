/**
 * 列表视图状态的单测。
 *
 * 这几条规则都是「做反了也不报错」的类型：过滤词丢了、参数被冲掉、
 * 密度取值写错 —— 全都不会崩，只是用起来难受，所以只能用测试钉住。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  DEFAULT_DENSITY,
  DENSITY_ROW_HEIGHT,
  FILTER_DEBOUNCE_MS,
  FILTER_PARAM,
  SCROLL_THROTTLE_MS,
  chipOverflow,
  densityRowClass,
  densityRowHeight,
  densityRowPadding,
  filterChanged,
  filterFromParams,
  isDensity,
  shouldCommitFilter,
  shouldRunThrottled,
  withFilter,
} from "./list-view.ts";

test("没有 q 参数时过滤词为空串", () => {
  assert.equal(filterFromParams(new URLSearchParams("")), "");
  assert.equal(filterFromParams(new URLSearchParams("page=2")), "");
});

test("q 参数原样读出，不做 trim", () => {
  // 输入框里正在打字的中间态不能被「修正」，否则光标会往回跳。
  assert.equal(filterFromParams(new URLSearchParams("q=order%201")), "order 1");
  assert.equal(filterFromParams(new URLSearchParams("q=%20%20")), "  ");
});

test("写入过滤词保留其它参数", () => {
  const params = new URLSearchParams("page=2&sort=lag");
  const next = withFilter(params, "orders");
  assert.equal(next.get("page"), "2");
  assert.equal(next.get("sort"), "lag");
  assert.equal(next.get(FILTER_PARAM), "orders");
});

test("空过滤词删掉参数，而不是留一个 q=", () => {
  const next = withFilter(new URLSearchParams("q=orders&page=1"), "   ");
  assert.equal(next.has(FILTER_PARAM), false);
  assert.equal(next.get("page"), "1");
  assert.equal(next.toString(), "page=1");
});

test("清除过滤词不动原对象", () => {
  const params = new URLSearchParams("q=a");
  withFilter(params, "");
  assert.equal(params.get(FILTER_PARAM), "a");
});

test("同值不算改变，避免历史里堆重复记录", () => {
  assert.equal(filterChanged("", ""), false);
  assert.equal(filterChanged("order", "order"), false);
  assert.equal(filterChanged("order", "orders"), true);
});

test("密度取值与默认档", () => {
  assert.equal(DEFAULT_DENSITY, "compact");
  assert.equal(isDensity("compact"), true);
  assert.equal(isDensity("comfortable"), true);
  assert.equal(isDensity("loose"), false);
  assert.equal(isDensity(undefined), false);
});

test("两档密度给出不同的行内边距", () => {
  assert.notEqual(densityRowClass("compact"), densityRowClass("comfortable"));
  assert.equal(densityRowClass("compact"), "py-1.5");
});

test("行高两档都已知，且与行内边距同向变化", () => {
  assert.equal(densityRowHeight("compact"), DENSITY_ROW_HEIGHT.compact);
  assert.ok(DENSITY_ROW_HEIGHT.comfortable > DENSITY_ROW_HEIGHT.compact);
});

test("行高与行内边距同一份来源：宽松档比紧凑档多出的正好是两倍 padding 差", () => {
  // 紧凑 1.5 → 宽松 2.5（Tailwind 单位 0.25rem = 4px，两侧共 8px）。
  assert.equal(DENSITY_ROW_HEIGHT.comfortable - DENSITY_ROW_HEIGHT.compact, 8);
});

test("只在与已提交值不同时才写 URL", () => {
  assert.equal(shouldCommitFilter({ draft: "ord", keyword: "ord" }), false);
  assert.equal(shouldCommitFilter({ draft: "orde", keyword: "ord" }), true);
  // 清空也是一次真正的改变。
  assert.equal(shouldCommitFilter({ draft: "", keyword: "ord" }), true);
});

test("去抖与节流的间隔都是正数，且去抖长于一帧", () => {
  assert.ok(FILTER_DEBOUNCE_MS > SCROLL_THROTTLE_MS);
  assert.equal(SCROLL_THROTTLE_MS, 16);
});

test("滚动节流：一帧之内不重复计算，跨帧才放行", () => {
  assert.equal(shouldRunThrottled(0, 8), false);
  assert.equal(shouldRunThrottled(0, 16), true);
  assert.equal(shouldRunThrottled(1000, 1008, 4), true);
});

// 过滤框「打了又改回原样」不该落 URL：一次空提交会重渲染整个列表页。
test("草案与已提交值相同时不提交", () => {
  assert.equal(shouldCommitFilter({ draft: "order", keyword: "order" }), false);
  assert.equal(shouldCommitFilter({ draft: "", keyword: "" }), false);
});

test("真的改了才提交", () => {
  assert.equal(shouldCommitFilter({ draft: "order", keyword: "ord" }), true);
  assert.equal(shouldCommitFilter({ draft: "", keyword: "order" }), true);
});

// 密度档的三种表示（类名 / CSS 变量 / 行高）必须来自同一份映射。
test("两档密度的行内边距与行高一一对应", () => {
  assert.notEqual(densityRowPadding("compact"), densityRowPadding("comfortable"));
  assert.ok(densityRowHeight("compact") < densityRowHeight("comfortable"));
});

// —— 候选 chip 的溢出 ——————————————————————————————————————————

test("候选没超出上限时原样平铺，不显示「更多」", () => {
  assert.deepEqual(chipOverflow(3, 6, 1), { visible: 3, hidden: 0 });
  assert.deepEqual(chipOverflow(6, 6, 1), { visible: 6, hidden: 0 });
});

test("候选超出上限时给「更多」留一格，并报出藏了几个", () => {
  // 回归：原来直接 slice(0, 6)，第 7 个候选连提都不提。
  assert.deepEqual(chipOverflow(9, 6, 1), { visible: 5, hidden: 4 });
  assert.deepEqual(chipOverflow(7, 6, 1), { visible: 5, hidden: 2 });
});

test("上限为 1 时留不住「更多」的位置，就少显示一个候选", () => {
  // max=1 时 visible=0 会把候选全藏起来，那还不如平铺；这里退化为直接占满。
  assert.deepEqual(chipOverflow(4, 1, 1), { visible: 1, hidden: 3 });
});

test("没有候选或上限非正时不报数字", () => {
  assert.deepEqual(chipOverflow(0, 6, 1), { visible: 0, hidden: 0 });
  assert.deepEqual(chipOverflow(5, 0, 1), { visible: 0, hidden: 0 });
});

test("不预留位置时溢出项全部平铺，调用方自己决定折叠", () => {
  assert.deepEqual(chipOverflow(9, 6, 0), { visible: 6, hidden: 3 });
});
