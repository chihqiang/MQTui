/**
 * 外壳布局规则的测试。
 *
 * 三条规则错了都不会崩：窄屏不降级只是挤、分组把「主题」放进配置区只是难找、
 * 未知能力落进空分组只是菜单少一项。所以逐条钉住。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  DEFAULT_LAYOUT,
  NARROW_WIDTH,
  groupNavItems,
  isLayoutMode,
  navGroupOf,
  resolveLayout,
} from "./layout.ts";

test("宽度未知时不降级，按用户偏好先铺一版", () => {
  assert.equal(resolveLayout("grouped", null), "grouped");
  assert.equal(resolveLayout("classic", null), "classic");
});

test("窄屏一律降到极简，宽屏回到用户偏好", () => {
  assert.equal(resolveLayout("grouped", NARROW_WIDTH - 1), "collapsed");
  assert.equal(resolveLayout("classic", 320), "collapsed");
  // 正好等于阈值算宽屏：边界不该因为用 < 还是 <= 而让 900px 的用户左右横跳。
  assert.equal(resolveLayout("classic", NARROW_WIDTH), "classic");
  assert.equal(resolveLayout("grouped", 1600), "grouped");
});

test("偏好的形状校验挡住脏数据", () => {
  assert.equal(isLayoutMode("grouped"), true);
  assert.equal(isLayoutMode("collapsed"), true);
  assert.equal(isLayoutMode("grid"), false);
  assert.equal(isLayoutMode(undefined), false);
  assert.equal(isLayoutMode(DEFAULT_LAYOUT), true);
});

test("日常页和配置页落在不同分组", () => {
  assert.equal(navGroupOf("topics"), "operate");
  assert.equal(navGroupOf("queues"), "operate");
  assert.equal(navGroupOf("cluster"), "observe");
  assert.equal(navGroupOf("policies"), "config");
  assert.equal(navGroupOf("offsetReset"), "config");
});

test("未知能力落进观测组，不会凭空消失", () => {
  // 后端加了一个前端还不认识的能力时，菜单必须照旧渲染出来，
  // 只是归到「观测」这个兜底组 —— 静默丢一项最难查。
  assert.equal(navGroupOf("nexus"), "observe");
});

test("分组保持后端顺序，空组不进结果", () => {
  const items = [
    { capability: "overview" },
    { capability: "topics" },
    { capability: "consumerGroups" },
    { capability: "policies" },
  ];
  const groups = groupNavItems(items);
  assert.deepEqual(
    groups.map((group) => group.group),
    ["operate", "observe", "config"],
  );
  // operate 内部按原顺序：topics 在 consumerGroups 之前。
  assert.deepEqual(
    groups[0].items.map((item) => item.capability),
    ["topics", "consumerGroups"],
  );
});

test("只有一项的组也照常返回，由调用方决定要不要画标题", () => {
  const groups = groupNavItems([{ capability: "policies" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].group, "config");
  assert.equal(groups[0].items.length, 1);
});

test("空菜单返回空数组，不返回一个空分组", () => {
  assert.deepEqual(groupNavItems([]), []);
});
