import { expect, test } from "vitest";

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
  patch: Partial<GroupRemovalPreflight> = {}
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
  expect(a).toBe(b);
  expect(groupRemovalKey(["  "])).toBe("");
});

test("键把组名分开，不会把 a b 与 ab 当成同一批", () => {
  expect(groupRemovalKey(["a", "b"])).not.toBe(groupRemovalKey(["ab"]));
});

test("有成员才用危险色，读不到用中性", () => {
  expect(checkTone(check({ blocked: true }))).toBe("danger");
  expect(checkTone(check())).toBe("neutral");
  expect(checkTone(check({ members: null }))).toBe("neutral");
});

test("成员数读不到不写成 0", () => {
  expect(memberText(check({ members: null }))).toBe("成员数读不到");
  expect(memberText(check({ members: 0 }))).toBe("无在线成员");
  expect(memberText(check({ members: 3 }))).toBe("3 个在线成员");
});

test("按是否被拦分组", () => {
  const report = preflight([
    check({ group: "a" }),
    check({ group: "b", blocked: true, members: 1 }),
  ]);
  expect(blockedChecks(report).map((item) => item.group)).toEqual(["b"]);
  expect(clearChecks(report).map((item) => item.group)).toEqual(["a"]);
});

test("预检失败时不说成后端的结论", () => {
  expect(preflightHeadline(undefined, true)).toMatch(/预检没做成/);
  expect(preflightHeadline(undefined, false)).toMatch(/正在检查/);
  expect(preflightHeadline(preflight([check()]), false)).toBe("共 1 个组");
});

test("还有能删的组时允许提交", () => {
  expect(canSubmit(
      preflight([check(), check({ group: "b", blocked: true, members: 2 })])
    )).toBe(true);
});

test("全部被占着时不允许提交", () => {
  expect(canSubmit(
      preflight([
        check({ group: "a", blocked: true, members: 1 }),
        check({ group: "b", blocked: true, members: 2 }),
      ])
    )).toBe(false);
});

test("没有预检结果时不拦人", () => {
  expect(canSubmit(undefined)).toBe(true);
  expect(canSubmit(preflight([]))).toBe(true);
});
