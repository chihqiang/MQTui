// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

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
  assert.equal(canLogin(user("shovel", [])), false);
  assert.equal(canLogin(user("ops", ["management"])), true);
  assert.equal(canLogin(user("ops", ["administrator"])), true);
  // impersonator 是给 shovel / federation 用的，不能登录。
  assert.equal(canLogin(user("ops", ["impersonator"])), false);
});

test("未知标签原样展示但不参与判断", () => {
  const item = user("ops", ["administrator", "my-plugin-role"]);
  assert.deepEqual(parsedTags(item), ["administrator"]);
  assert.equal(isAdmin(item), true);
  assert.equal(describeTags(item), "管理员 · my-plugin-role");
});

test("空标签列表显示为「无」", () => {
  assert.equal(describeTags(user("ops", [])), "无");
});

test("三段全开被识别出来", () => {
  assert.equal(isFullAccess(permission(".*", ".*", ".*")), true);
  assert.equal(isFullAccess(permission(".*", "orders.*", ".*")), false);
  assert.deepEqual(emptySegments(permission("", "orders.*", "")), ["configure", "read"]);
});

test("撤销权限的说明写清「不是限制而是停止」", () => {
  const text = permissionRemovalWarning(permission(".*", ".*", ".*"));
  assert.match(text, /掉线/);
  assert.match(text, /不会自己恢复/);
});

test("默认 vhost 与当前 vhost 都删不得，理由不同", () => {
  assert.match(vhostRemovalBlock(vhost(DEFAULT_VHOST), "/") ?? "", /连接串/);
  // 非默认但正在用的 vhost：删了不会报错，只是所有页面一起失效。
  assert.match(vhostRemovalBlock(vhost("orders"), "orders") ?? "", /所有页面失效/);
  assert.equal(vhostRemovalBlock(vhost("other"), "orders"), null);
});

test("当前账号删不得", () => {
  assert.match(userRemovalBlock(user("admin", []), "admin") ?? "", /锁在门外/);
  assert.equal(userRemovalBlock(user("app", []), "admin"), null);
});

test("删 vhost 的提示带上队列与权限条数", () => {
  const text = vhostRemovalWarning(vhost("orders", 12, 3));
  assert.match(text, /12 个队列/);
  assert.match(text, /3 条权限/);
  assert.match(text, /不可撤销/);
});

test("用户名里的空白字符会被拦下", () => {
  assert.match(badUserName("  ") ?? "", /不能为空/);
  assert.match(badUserName("ops team") ?? "", /空白/);
  assert.equal(badUserName("ops-team"), null);
});

test("口令只挡最明显的两类", () => {
  assert.match(weakPassword("ops", "ops") ?? "", /用户名相同/);
  assert.match(weakPassword("ops", "short") ?? "", /少于 8 位/);
  assert.equal(weakPassword("ops", "longenough"), null);
  // 空密码交给「新建必填」那条判断，这里不重复报错。
  assert.equal(weakPassword("ops", ""), null);
});

test("用户过滤命中名字与标签", () => {
  const item = user("app-orders", ["management"]);
  assert.equal(userMatches(item, ""), true);
  assert.equal(userMatches(item, "ORDER"), true);
  assert.equal(userMatches(item, "MANAGEMENT"), true);
  assert.equal(userMatches(item, "nope"), false);
});

test("vhost 摘要把全开权限单独提出来", () => {
  assert.equal(describeVhost(vhost("orders", 2, 1, 1)), "2 个队列 · 1 条权限 · 1 条全开");
});
