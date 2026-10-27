/**
 * 外壳布局规则的测试。
 *
 * 两条规则错了都不会崩：窄屏不降级只是挤、折叠状态存反了只是新连接被藏住。
 * 所以逐条钉住。
 */

import { expect, test } from "vitest";

import {
  DEFAULT_LAYOUT,
  NARROW_WIDTH,
  groupConnectionsByKind,
  isGroupExpanded,
  resolveLayout,
} from "./layout.ts";

test("宽度未知时不降级，按默认布局先铺一版", () => {
  expect(resolveLayout(null)).toBe(DEFAULT_LAYOUT);
});

test("窄屏一律降到图标条，宽屏回到侧栏", () => {
  expect(resolveLayout(NARROW_WIDTH - 1)).toBe("rail");
  expect(resolveLayout(320)).toBe("rail");
  // 正好等于阈值算宽屏：边界不该因为用 < 还是 <= 而让 900px 的用户左右横跳。
  expect(resolveLayout(NARROW_WIDTH)).toBe(DEFAULT_LAYOUT);
  expect(resolveLayout(1600)).toBe(DEFAULT_LAYOUT);
});

test("默认布局是侧栏，窄屏降级为图标条", () => {
  expect(DEFAULT_LAYOUT).toBe("sidebar");
  expect(resolveLayout(NARROW_WIDTH - 1)).toBe("rail");
});

test("连接按中间件分组，组内保持原顺序", () => {
  const groups = groupConnectionsByKind([
    { a: 1, kind: "kafka" },
    { b: 2, kind: "rabbitMq" },
    { c: 3, kind: "kafka" },
  ]);
  expect(groups.map((group) => group.kind)).toEqual(["kafka", "rabbitMq"]);
  expect(groups[0].items.map((item) => item.a ?? item.c)).toEqual([1, 3]);
});

test("组默认展开，手动折起来的那几个才算折叠", () => {
  const collapsed = new Set(["kind:rabbitMq"]);
  expect(isGroupExpanded(collapsed, "kind:kafka")).toBe(true);
  expect(isGroupExpanded(collapsed, "kind:rabbitMq")).toBe(false);
  // 存的是「折起来的」，所以新出现的组不会继承一份旧的折叠状态。
  expect(isGroupExpanded(collapsed, "pages:new-connection")).toBe(true);
});
