/**
 * 集群页展示逻辑的单测。
 *
 * 重点不是「函数能跑」，而是几条**必须这么显示**的规则：
 * 上限未知时不能显示 0%、离线节点不能被角色颜色洗白、没有节点的队列不能被当成「没数据」。
 */

import { expect, test } from "vitest";

import {
  describeCluster,
  fdRatioText,
  memRatioText,
  nodeTone,
  placementRisk,
  placementText,
  roleTone,
  statTone,
} from "./cluster.ts";

function stat(overrides = {}) {
  return {
    name: "rabbit@n1",
    running: true,
    memUsed: 500,
    memLimit: 1000,
    diskFree: 10_000,
    diskLimit: 1_000,
    fdUsed: 10,
    fdTotal: 100,
    socketsUsed: 1,
    socketsTotal: 10,
    procUsed: 10,
    procTotal: 1000,
    alarm: false,
    ...overrides,
  };
}

test("内存上限未知时不给百分比", () => {
  expect(memRatioText(stat({ memLimit: 0 }))).toBe(null);
  expect(memRatioText(stat())).toBe("50%");
});

test("fd 上限未知时不给百分比", () => {
  expect(fdRatioText(stat({ fdTotal: 0 }))).toBe(null);
});

test("服务端告警优先于本地阈值判断", () => {
  expect(statTone(stat({ alarm: true, memUsed: 10 }))).toBe("danger");
});

test("内存跨过 80% 观察线降为 warning", () => {
  expect(statTone(stat({ memUsed: 799 }))).toBe("success");
  expect(statTone(stat({ memUsed: 800 }))).toBe("warning");
});

test("没有上限就不判内存", () => {
  expect(statTone(stat({ memLimit: 0, memUsed: 9_999_999 }))).toBe("success");
});

test("磁盘低于下限是 danger", () => {
  expect(statTone(stat({ diskFree: 500 }))).toBe("danger");
});

test("离线节点的颜色不受角色影响", () => {
  const node = {
    name: "rabbit@n1",
    role: "controller" as const,
    roleLabel: "控制节点",
    running: false,
  };
  expect(nodeTone(node)).toBe("danger");
  expect(roleTone(node.role)).toBe("success");
});

test("没有节点的队列显示成不可用而不是空字符串", () => {
  const queue = { name: "orders", vhost: "/", nodes: [], kind: "classic", durable: true, exclusive: false };
  expect(placementText(queue)).toBe("未分配（当前不可用）");
  expect(placementRisk(queue)).toMatch(/不可用/);
});

test("单副本经典队列会提示节点故障即不可用", () => {
  const queue = { name: "orders", vhost: "/", nodes: ["rabbit@n1"], kind: "classic", durable: true, exclusive: false };
  expect(placementRisk(queue)).toMatch(/单副本/);
});

test("单成员仲裁队列比单副本更危险", () => {
  const queue = { name: "pay", vhost: "/", nodes: ["rabbit@n1"], kind: "quorum", durable: true, exclusive: false };
  expect(placementRisk(queue)).toMatch(/多数派/);
});

test("三成员仲裁队列没有风险提示", () => {
  const queue = {
    name: "pay",
    vhost: "/",
    nodes: ["a", "b", "c"],
    kind: "quorum",
    durable: true,
    exclusive: false,
  };
  expect(placementRisk(queue)).toBe(null);
});

test("总结里同时给运行数与待关注条数", () => {
  const nodes = [
    { name: "a", role: "disc" as const, roleLabel: "磁盘节点", running: true },
    { name: "b", role: "disc" as const, roleLabel: "磁盘节点", running: false },
  ];
  expect(describeCluster(nodes, 1)).toBe("1/2 个节点在运行，1 条需要关注的结论");
  expect(describeCluster([], 0)).toBe("未获取到节点信息");
});
