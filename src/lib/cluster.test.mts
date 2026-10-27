/**
 * 集群页展示逻辑的单测。
 *
 * 重点不是「函数能跑」，而是几条**必须这么显示**的规则：
 * 上限未知时不能显示 0%、离线节点不能被角色颜色洗白、没有节点的队列不能被当成「没数据」。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

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
  assert.equal(memRatioText(stat({ memLimit: 0 })), null);
  assert.equal(memRatioText(stat()), "50%");
});

test("fd 上限未知时不给百分比", () => {
  assert.equal(fdRatioText(stat({ fdTotal: 0 })), null);
});

test("服务端告警优先于本地阈值判断", () => {
  assert.equal(statTone(stat({ alarm: true, memUsed: 10 })), "danger");
});

test("内存跨过 80% 观察线降为 warning", () => {
  assert.equal(statTone(stat({ memUsed: 799 })), "success");
  assert.equal(statTone(stat({ memUsed: 800 })), "warning");
});

test("没有上限就不判内存", () => {
  assert.equal(statTone(stat({ memLimit: 0, memUsed: 9_999_999 })), "success");
});

test("磁盘低于下限是 danger", () => {
  assert.equal(statTone(stat({ diskFree: 500 })), "danger");
});

test("离线节点的颜色不受角色影响", () => {
  const node = {
    name: "rabbit@n1",
    role: "controller" as const,
    roleLabel: "控制节点",
    running: false,
  };
  assert.equal(nodeTone(node), "danger");
  assert.equal(roleTone(node.role), "success");
});

test("没有节点的队列显示成不可用而不是空字符串", () => {
  const queue = { name: "orders", vhost: "/", nodes: [], kind: "classic", durable: true, exclusive: false };
  assert.equal(placementText(queue), "未分配（当前不可用）");
  assert.match(placementRisk(queue), /不可用/);
});

test("单副本经典队列会提示节点故障即不可用", () => {
  const queue = { name: "orders", vhost: "/", nodes: ["rabbit@n1"], kind: "classic", durable: true, exclusive: false };
  assert.match(placementRisk(queue), /单副本/);
});

test("单成员仲裁队列比单副本更危险", () => {
  const queue = { name: "pay", vhost: "/", nodes: ["rabbit@n1"], kind: "quorum", durable: true, exclusive: false };
  assert.match(placementRisk(queue), /多数派/);
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
  assert.equal(placementRisk(queue), null);
});

test("总结里同时给运行数与待关注条数", () => {
  const nodes = [
    { name: "a", role: "disc" as const, roleLabel: "磁盘节点", running: true },
    { name: "b", role: "disc" as const, roleLabel: "磁盘节点", running: false },
  ];
  assert.equal(describeCluster(nodes, 1), "1/2 个节点在运行，1 条需要关注的结论");
  assert.equal(describeCluster([], 0), "未获取到节点信息");
});
