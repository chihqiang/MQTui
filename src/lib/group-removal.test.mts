// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  blockedChecks,
  canSubmit,
  checkTone,
  clearChecks,
  groupRemovalKey,
  memberText,
  preflightHeadline,
} from "./group-removal.ts";
import type {
  GroupRemovalCheck,
  GroupRemovalPreflight,
} from "../services/consumer-service.ts";

function check(patch: Partial<GroupRemovalCheck> = {}): GroupRemovalCheck {
  return {
    group: "orders",
    blocked: false,
    reason: "没有在线成员",
    members: 0,
    memberDetails: [],
    offsets: 0,
    ...patch,
  };
}

function preflight(
  groups: GroupRemovalCheck[],
  patch: Partial<GroupRemovalPreflight> = {},
): GroupRemovalPreflight {
  return {
    hasBlocked: groups.some((item) => item.blocked),
    headline: "共 1 个组",
    groups,
    unknown: [],
    ...patch,
  };
}

test("键的顺序不影响结果，空白与重复会被吃掉", () => {
  const a = groupRemovalKey([" b ", "a", "a"]);
  const b = groupRemovalKey(["a", "b"]);
  assert.equal(a, b);
  assert.equal(groupRemovalKey(["  "]), "");
});

test("键把组名分开，不会把 a b 与 ab 当成同一批", () => {
  assert.notEqual(groupRemovalKey(["a", "b"]), groupRemovalKey(["ab"]));
});

test("有成员才用危险色，读不到用中性", () => {
  assert.equal(checkTone(check({ blocked: true })), "danger");
  assert.equal(checkTone(check()), "neutral");
  assert.equal(checkTone(check({ members: null })), "neutral");
});

test("成员数读不到不写成 0", () => {
  assert.equal(memberText(check({ members: null })), "成员数读不到");
  assert.equal(memberText(check({ members: 0 })), "无在线成员");
  assert.equal(memberText(check({ members: 3 })), "3 个在线成员");
});

test("按是否被拦分组", () => {
  const report = preflight([
    check({ group: "a" }),
    check({ group: "b", blocked: true, members: 1 }),
  ]);
  assert.deepEqual(
    blockedChecks(report).map((item) => item.group),
    ["b"],
  );
  assert.deepEqual(
    clearChecks(report).map((item) => item.group),
    ["a"],
  );
});

test("预检失败时不说成后端的结论", () => {
  assert.match(preflightHeadline(undefined, true), /预检没做成/);
  assert.match(preflightHeadline(undefined, false), /正在检查/);
  assert.equal(preflightHeadline(preflight([check()]), false), "共 1 个组");
});

test("还有能删的组时允许提交", () => {
  assert.equal(
    canSubmit(
      preflight([check(), check({ group: "b", blocked: true, members: 2 })]),
    ),
    true,
  );
});

test("全部被占着时不允许提交", () => {
  assert.equal(
    canSubmit(
      preflight([
        check({ group: "a", blocked: true, members: 1 }),
        check({ group: "b", blocked: true, members: 2 }),
      ]),
    ),
    false,
  );
});

test("没有预检结果时不拦人", () => {
  assert.equal(canSubmit(undefined), true);
  assert.equal(canSubmit(preflight([])), true);
});
