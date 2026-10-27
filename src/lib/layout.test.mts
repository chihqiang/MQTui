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
  groupConnectionsByKind,
  groupNavItems,
  isGroupExpanded,
  navGroupOf,
  resolveLayout,
} from "./layout.ts";

test("宽度未知时不降级，按默认布局先铺一版", () => {
  assert.equal(resolveLayout(null), DEFAULT_LAYOUT);
});

test("窄屏一律降到图标条，宽屏回到侧栏", () => {
  assert.equal(resolveLayout(NARROW_WIDTH - 1), "rail");
  assert.equal(resolveLayout(320), "rail");
  // 正好等于阈值算宽屏：边界不该因为用 < 还是 <= 而让 900px 的用户左右横跳。
  assert.equal(resolveLayout(NARROW_WIDTH), DEFAULT_LAYOUT);
  assert.equal(resolveLayout(1600), DEFAULT_LAYOUT);
});

test("默认布局是侧栏，窄屏降级为图标条", () => {
  assert.equal(DEFAULT_LAYOUT, "sidebar");
  assert.equal(resolveLayout(NARROW_WIDTH - 1), "rail");
});

test("日常页和配置页落在不同分组", () => {
  assert.equal(navGroupOf("topics"), "operate");
  assert.equal(navGroupOf("queues"), "operate");
  assert.equal(navGroupOf("cluster"), "observe");
  assert.equal(navGroupOf("policies"), "config");
  assert.equal(navGroupOf("offsetReset"), "config");
});

test("连接按中间件分组，组内保持原顺序", () => {
  const groups = groupConnectionsByKind([
    { a: 1, kind: "kafka" },
    { b: 2, kind: "rabbitMq" },
    { c: 3, kind: "kafka" },
  ]);
  assert.deepEqual(
    groups.map((group) => group.kind),
    ["kafka", "rabbitMq"],
  );
  assert.deepEqual(
    groups[0].items.map((item) => item.a ?? item.c),
    [1, 3],
  );
});

test("组默认展开，手动折起来的那几个才算折叠", () => {
  const collapsed = new Set(["kind:rabbitMq"]);
  assert.equal(isGroupExpanded(collapsed, "kind:kafka"), true);
  assert.equal(isGroupExpanded(collapsed, "kind:rabbitMq"), false);
  // 存的是「折起来的」，所以新出现的组不会继承一份旧的折叠状态。
  assert.equal(isGroupExpanded(collapsed, "pages:new-connection"), true);
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
