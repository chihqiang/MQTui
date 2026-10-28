import { expect, test } from "vitest";

import {
  aclVerdict,
  canSubmit,
  changeTone,
  confirmTarget,
  entryFingerprint,
  entryPrincipalCount,
  failedOutcomes,
  invertPermission,
  planVerdict,
  reportVerdict,
  wideDeletes,
  blocksIntrospection,
  byPrincipal,
  denyCount,
  describeFilter,
  filterChips,
  filterEntries,
  isFilterEmpty,
  matchesFilter,
  principalName,
  resourceLabel,
  resourceNameLabel,
  selfLockRisks,
  serverFilter,
} from "./acl.ts";
import type { AclChangePlan, AclEntry, AclSnapshot, AclWriteReport } from "../types/acl.ts";

function entry(overrides: Partial<AclEntry> = {}): AclEntry {
  return {
    resourceType: "topic",
    resourceName: "orders",
    pattern: "literal",
    principal: "User:alice",
    host: "*",
    operation: "read",
    permission: "allow",
    ...overrides,
  };
}

function snapshot(entries: AclEntry[], unsupported?: string): AclSnapshot {
  return { entries, notes: [], ...(unsupported ? { unsupported } : {}) };
}

test("通配资源显示成「主题」，不是「主题 」", () => {
  const item = entry({ pattern: "wildcard", resourceName: "" });
  expect(resourceLabel(item)).toBe("主题");
});

test("集群资源的名字不重复出现", () => {
  const item = entry({
    resourceType: "cluster",
    resourceName: "kafka-cluster",
    principal: "User:admin",
    operation: "all",
  });
  expect(resourceLabel(item)).toBe("集群");
});

test("前缀资源保留前缀，并说明这是前缀", () => {
  const item = entry({ pattern: "prefixed", resourceName: "payments-" });
  // 只写 `主题 payments-`，末尾那个横线很容易被当成名字的一部分漏看，
  // 而「这一条覆盖了整个前缀」恰恰是要看出来的那件事。
  expect(resourceLabel(item)).toBe("主题 payments- 前缀");
});

test("独立的资源格：通配给 `*`，集群级资源不重复写名字", () => {
  expect(resourceNameLabel(entry({ pattern: "wildcard", resourceName: "" }))).toBe("*");
  expect(resourceNameLabel(entry({ pattern: "prefixed", resourceName: "payments-" }))).toBe(
    "payments-",
  );
  expect(
    resourceNameLabel(
      entry({ resourceType: "cluster", resourceName: "kafka-cluster", operation: "all" }),
    ),
  ).toBe("");
});

test("筛选徽标：一项一条，顺序固定，空过滤器不出徽标", () => {
  expect(filterChips({})).toEqual([]);
  const chips = filterChips({
    resourceName: "orders",
    principal: "alice",
    permission: "deny",
    operation: "read",
    resourceType: "topic",
  });
  // 顺序按「资源 → 操作 → 权限 → 主体 → 名字」排：改一个筛法时，
  // 徽标不会因为顺序漂移而换位置。
  expect(chips.map((chip) => chip.key)).toEqual([
    "resourceType",
    "operation",
    "permission",
    "principal",
    "resourceName",
  ]);
  expect(chips.map((chip) => chip.text)).toEqual([
    "资源 主题",
    "操作 读",
    "权限 拒绝",
    "主体含 alice",
    "名含 orders",
  ]);
});

test("主体只剥掉第一个冒号前的东西", () => {
  expect(principalName("User:CN=alice,OU=ops")).toBe("CN=alice,OU=ops");
  expect(principalName("Group:payments")).toBe("payments");
  expect(principalName("anonymous")).toBe("anonymous");
});

test("集群级 describe 的拒绝会被判成自锁风险", () => {
  const risky = entry({
    resourceType: "cluster",
    resourceName: "kafka-cluster",
    principal: "User:*",
    operation: "describe",
    permission: "deny",
  });
  expect(blocksIntrospection(risky)).toBe(true);
  // 只拒「改配置」不会挡住读，别乱报。
  expect(blocksIntrospection({ ...risky, operation: "alterConfigs" })).toBe(false);
  // 允许规则永远不会自锁。
  expect(blocksIntrospection({ ...risky, operation: "all", permission: "allow" })).toBe(false);
  // 限定来源主机的拒绝管不到面板自己（除非面板也从那个地址连）。
  expect(blocksIntrospection({ ...risky, host: "10.0.0.1" })).toBe(false);
});

test("自锁风险与拒绝条数分别统计", () => {
  const risky = entry({
    resourceType: "cluster",
    resourceName: "kafka-cluster",
    principal: "User:*",
    operation: "describe",
    permission: "deny",
  });
  const data = snapshot([risky, entry({ operation: "write", permission: "deny" }), entry()]);
  expect(denyCount(data)).toBe(2);
  expect(selfLockRisks(data)).toHaveLength(1);
});

test("按主体分组，组内按资源类型排序", () => {
  const groups = byPrincipal([
    entry({ principal: "User:zoe" }),
    entry({ principal: "User:alice", resourceType: "group", resourceName: "g" }),
    entry({ principal: "User:alice", resourceType: "topic", resourceName: "a" }),
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].principal).toBe("User:alice");
  expect(groups[0].entries[0].resourceType).toBe("group");
  expect(groups[0].entries[1].resourceType).toBe("topic");
});

test("不支持时不能把空表说成「没有任何 ACL」", () => {
  const data = snapshot([], "需要 2.0 以上");
  expect(aclVerdict(data)).toMatch(/读不到/);
  expect(aclVerdict(data)).not.toMatch(/没有任何 ACL/);
});

test("空快照要说清是「没有规则」而不是「一切正常」", () => {
  expect(aclVerdict(snapshot([]))).toMatch(/没有任何 ACL/);
});

test("有拒绝规则时结论里点名条数", () => {
  const data = snapshot([entry(), entry({ permission: "deny" })]);
  expect(aclVerdict(data)).toMatch(/其中 1 条是拒绝/);
});

test("过滤器区分「没设」与「空串」", () => {
  expect(isFilterEmpty({})).toBe(true);
  // 空串也算设了：它不是「不过滤」，而是「名字为空」。
  expect(isFilterEmpty({ resourceName: "" })).toBe(false);
  expect(matchesFilter(entry(), { resourceName: "" })).toBe(true);
  expect(matchesFilter(entry(), { resourceName: "payments" })).toBe(false);
});

test("过滤器对名字与主体忽略大小写", () => {
  const item = entry({ resourceName: "Orders", principal: "User:Alice" });
  expect(matchesFilter(item, { principal: "alice" })).toBe(true);
  expect(matchesFilter(item, { resourceName: "orders" })).toBe(true);
});

test("操作与权限严格匹配", () => {
  expect(matchesFilter(entry(), { operation: "write" })).toBe(false);
  expect(matchesFilter(entry(), { operation: "read" })).toBe(true);
  expect(matchesFilter(entry(), { permission: "deny" })).toBe(false);
});

test("过滤描述要说清筛了什么", () => {
  expect(describeFilter({})).toBe("全部规则");
  expect(describeFilter({ resourceType: "topic", permission: "deny" })).toBe("筛选：主题 · 拒绝");
});

test("filterEntries 只留下命中的规则", () => {
  const entries = [entry(), entry({ resourceType: "group", resourceName: "g" })];
  expect(filterEntries(entries, { resourceType: "group" })).toHaveLength(1);
});

test("本地「包含」筛选不下发给服务端", () => {
  // 服务端只做精确匹配，把「含」下发下去会拿到一张空表 —— 那张空表读起来
  // 像「一条规则都没有」。
  expect(serverFilter({ resourceName: "pay", principal: "ali", operation: "read" })).toEqual({
    resourceType: undefined,
    operation: "read",
    permission: undefined,
  });
});

// ---- 写入预演：结论必须说得比「新增成功」更细 ----

test("全都已存在时结论不能说「N 条会改变集群」", () => {
  const plan: AclChangePlan = {
    changes: [{ entry: entry(), verdict: "exists", related: [] }],
    effective: 0,
    blockers: [],
    notes: [],
  };
  // 「已存在」混进「新增」会报出一个虚高的数字，用户按那个数字判断风险。
  expect(planVerdict(plan)).toContain("不会改变任何东西");
});

test("有条目冲突时结论里必须出现「冲突」", () => {
  const plan: AclChangePlan = {
    changes: [
      { entry: entry(), verdict: "conflicts", related: ["已有「拒绝」"] },
      { entry: entry({ principal: "User:bob" }), verdict: "new", related: [] },
    ],
    effective: 1,
    blockers: [],
    notes: [],
  };
  expect(planVerdict(plan)).toContain("1 条与现有规则冲突");
});

test("空预演不说「0 条规则已生效」", () => {
  expect(planVerdict({ changes: [], effective: 0, blockers: [], notes: [] })).toBe(
    "没有要提交的规则",
  );
});

test("有拦路风险时提交按钮要求先勾确认，而不是禁用", () => {
  const plan: AclChangePlan = {
    changes: [{ entry: entry(), verdict: "new", related: [] }],
    effective: 1,
    blockers: ["主体 User:* 是「所有用户」"],
    notes: [],
  };
  // 禁用会让一个合法操作彻底做不了 —— 这类风险（比如删掉一条集群级拒绝）有时正是要做的。
  expect(canSubmit(plan, false)).toBe(false);
  expect(canSubmit(plan, true)).toBe(true);
});

test("effective 为 0 时不给提交", () => {
  const plan: AclChangePlan = {
    changes: [{ entry: entry(), verdict: "superseded", related: [] }],
    effective: 0,
    blockers: [],
    notes: [],
  };
  expect(canSubmit(plan, true)).toBe(false);
});

test("没有预演时不能提交", () => {
  expect(canSubmit(undefined, true)).toBe(false);
});

test("跨主体提交拿不到确认目标", () => {
  expect(confirmTarget([entry(), entry({ principal: "User:bob" })])).toBeNull();
  expect(entryPrincipalCount([entry(), entry({ principal: "User:bob" })])).toBe(2);
  expect(confirmTarget([entry()])).toBe("alice");
});

test("翻权限只改权限方向", () => {
  const flipped = invertPermission(entry());
  expect(flipped.permission).toBe("deny");
  expect(flipped.operation).toBe("read");
  expect(flipped.resourceName).toBe("orders");
});

test("指纹能区分只差一个字段的两条规则", () => {
  expect(entryFingerprint(entry())).not.toBe(entryFingerprint(entry({ operation: "write" })));
  expect(entryFingerprint(entry())).toBe(entryFingerprint(entry()));
});

test("回执里失败的那几条被单独列出来", () => {
  const report: AclWriteReport = {
    outcomes: [
      { entry: entry(), ok: true, message: "已新建", matched: 1 },
      { entry: entry({ principal: "User:bob" }), ok: false, message: "权限不足", matched: 0 },
    ],
    applied: 1,
    notes: [],
  };
  expect(reportVerdict(report)).toBe("2 条规则里 1 条成功、1 条失败");
  expect(failedOutcomes(report)).toHaveLength(1);
});

test("删除命中不止一条要单独提示", () => {
  const report: AclWriteReport = {
    outcomes: [{ entry: entry(), ok: true, message: "已删除", matched: 3 }],
    applied: 3,
    notes: [],
  };
  expect(wideDeletes(report)).toBe(1);
});

test("结论语气：冲突最重，被覆盖不是「成功」", () => {
  expect(changeTone("conflicts")).toBe("danger");
  expect(changeTone("superseded")).toBe("warning");
  expect(changeTone("new")).toBe("success");
});
