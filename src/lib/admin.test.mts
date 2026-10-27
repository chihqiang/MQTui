import { expect, test } from "vitest";

import {
  DEFAULT_VHOST,
  badUserName,
  canLogin,
  describeTags,
  describeVhost,
  emptySegments,
  isAdmin,
  isFullAccess,
  parsedTags,
  permissionRemovalWarning,
  userMatches,
  userRemovalBlock,
  vhostRemovalBlock,
  vhostRemovalWarning,
  weakPassword,
} from "./admin.ts";
import type { PermissionInfo, UserInfo, VhostRow } from "../types/admin.ts";

function user(name: string, tags: string[]): UserInfo {
  return { name, tags };
}

function permission(configure: string, write: string, read: string): PermissionInfo {
  return { user: "app", vhost: "orders", configure, write, read };
}

function vhost(name: string, queues = 0, permissions = 0, fullAccess = 0): VhostRow {
  return { name, description: "", tracing: false, queues, permissions, fullAccess };
}

test("空标签的用户登不进管理界面", () => {
  // 建好了、密码也对，但服务端不报错，只是在管理页看不到东西。
  expect(canLogin(user("shovel", []))).toBe(false);
  expect(canLogin(user("ops", ["management"]))).toBe(true);
  expect(canLogin(user("ops", ["administrator"]))).toBe(true);
  // impersonator 是给 shovel / federation 用的，不能登录。
  expect(canLogin(user("ops", ["impersonator"]))).toBe(false);
});

test("未知标签原样展示但不参与判断", () => {
  const item = user("ops", ["administrator", "my-plugin-role"]);
  expect(parsedTags(item)).toEqual(["administrator"]);
  expect(isAdmin(item)).toBe(true);
  expect(describeTags(item)).toBe("管理员 · my-plugin-role");
});

test("空标签列表显示为「无」", () => {
  expect(describeTags(user("ops", []))).toBe("无");
});

test("三段全开被识别出来", () => {
  expect(isFullAccess(permission(".*", ".*", ".*"))).toBe(true);
  expect(isFullAccess(permission(".*", "orders.*", ".*"))).toBe(false);
  expect(emptySegments(permission("", "orders.*", ""))).toEqual(["configure", "read"]);
});

test("撤销权限的说明写清「不是限制而是停止」", () => {
  const text = permissionRemovalWarning(permission(".*", ".*", ".*"));
  expect(text).toMatch(/掉线/);
  expect(text).toMatch(/不会自己恢复/);
});

test("默认 vhost 与当前 vhost 都删不得，理由不同", () => {
  expect(vhostRemovalBlock(vhost(DEFAULT_VHOST), "/") ?? "").toMatch(/连接串/);
  // 非默认但正在用的 vhost：删了不会报错，只是所有页面一起失效。
  expect(vhostRemovalBlock(vhost("orders"), "orders") ?? "").toMatch(/所有页面失效/);
  expect(vhostRemovalBlock(vhost("other"), "orders")).toBe(null);
});

test("当前账号删不得", () => {
  expect(userRemovalBlock(user("admin", []), "admin") ?? "").toMatch(/锁在门外/);
  expect(userRemovalBlock(user("app", []), "admin")).toBe(null);
});

test("删 vhost 的提示带上队列与权限条数", () => {
  const text = vhostRemovalWarning(vhost("orders", 12, 3));
  expect(text).toMatch(/12 个队列/);
  expect(text).toMatch(/3 条权限/);
  expect(text).toMatch(/不可撤销/);
});

test("用户名里的空白字符会被拦下", () => {
  expect(badUserName("  ") ?? "").toMatch(/不能为空/);
  expect(badUserName("ops team") ?? "").toMatch(/空白/);
  expect(badUserName("ops-team")).toBe(null);
});

test("口令只挡最明显的两类", () => {
  expect(weakPassword("ops", "ops") ?? "").toMatch(/用户名相同/);
  expect(weakPassword("ops", "short") ?? "").toMatch(/少于 8 位/);
  expect(weakPassword("ops", "longenough")).toBe(null);
  // 空密码交给「新建必填」那条判断，这里不重复报错。
  expect(weakPassword("ops", "")).toBe(null);
});

test("用户过滤命中名字与标签", () => {
  const item = user("app-orders", ["management"]);
  expect(userMatches(item, "")).toBe(true);
  expect(userMatches(item, "ORDER")).toBe(true);
  expect(userMatches(item, "MANAGEMENT")).toBe(true);
  expect(userMatches(item, "nope")).toBe(false);
});

test("vhost 摘要把全开权限单独提出来", () => {
  expect(describeVhost(vhost("orders", 2, 1, 1))).toBe("2 个队列 · 1 条权限 · 1 条全开");
});
