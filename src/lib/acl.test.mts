import { expect, test } from "vitest";

import {
  aclVerdict,
  blocksIntrospection,
  byPrincipal,
  denyCount,
  describeFilter,
  filterEntries,
  isFilterEmpty,
  matchesFilter,
  principalName,
  resourceLabel,
  selfLockRisks,
  serverFilter,
} from "./acl.ts";
import type { AclEntry, AclSnapshot } from "../types/acl.ts";

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

test("前缀资源保留前缀", () => {
  const item = entry({ pattern: "prefixed", resourceName: "payments-" });
  expect(resourceLabel(item)).toBe("主题 payments-");
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
