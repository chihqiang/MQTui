/**
 * 外壳布局规则的测试。
 *
 * 这些规则错了都不会崩：窄屏不降级只是挤，连接没按中间件分段只是点「主题」
 * 前得先自己确认在哪台机器上。所以逐条钉住。
 */

import { expect, test } from "vitest";

import * as layout from "./layout.ts";
import { DEFAULT_LAYOUT, NARROW_WIDTH, connectionFoldKey, resolveLayout } from "./layout.ts";

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

test("侧栏只要两层：不导出任何「分类分组」或「集合式折叠」的规则", () => {
  // 分类（中间件分组）这一层已经删掉，折叠归每条连接行自己持有 ——
  // 集合式折叠在这里判不出错，但会让箭头点了没反应，见 `useConnectionFold`。
  const exported = Object.keys(layout);
  expect(exported).not.toContain("groupConnectionsByKind");
  expect(exported).not.toContain("isConnectionExpanded");
  expect(exported).not.toContain("toggleConnectionFold");
  expect(exported).not.toContain("isGroupExpanded");
});

const kafkaProd = { kind: "kafka", endpoint: "10.0.1.12:9092" };

test("折叠键按 kind + endpoint 记，不认运行时 ID", () => {
  // ID 重启就换，用它当键的话折起来的连接每次开机都会自己弹开。
  expect(connectionFoldKey(kafkaProd)).toBe("kafka@10.0.1.12:9092");
  expect(connectionFoldKey({ ...kafkaProd, id: "abc" } as never)).toBe("kafka@10.0.1.12:9092");
});

test("折叠键认得出同一台机器上的两种中间件", () => {
  expect(connectionFoldKey({ kind: "rabbitmq", endpoint: "10.0.1.12:9092" })).toBe(
    "rabbitmq@10.0.1.12:9092",
  );
});
