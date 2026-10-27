/** 集群页展示逻辑的补充单测：只看需处理、占比条颜色、承载文案。 */

import { expect, test } from "vitest";

import { barTone, loadText, needsAttention } from "./cluster.ts";
import type { ClusterNode, NodeStat } from "../types/cluster.ts";

const node: ClusterNode = { name: "n1", role: "member", roleLabel: "成员", running: true };

test("不运行的节点必须留下", () => {
  expect(needsAttention({ ...node, running: false }, undefined)).toBe(true);
  expect(needsAttention(node, undefined)).toBe(false);
});

test("后端标了 attention 的节点留下", () => {
  expect(needsAttention(node, { name: "n1", headline: "", detail: "", attention: true })).toBe(true);
});

test("占比条不画中性色：正常态用绿", () => {
  const stat: NodeStat = {
    name: "n1",
    running: true,
    alarm: false,
    memUsed: 10,
    memLimit: 100,
    diskFree: 100,
    diskLimit: 10,
    fdUsed: 1,
    fdTotal: 100,
    socketsUsed: 0,
    socketsTotal: 0,
    procUsed: 0,
    procTotal: 0,
  };
  expect(barTone(stat)).toBe("success");
});

test("两种中间件的承载文案不同", () => {
  expect(loadText({ ...node, queues: 12 })).toMatch(/队列/);
  expect(loadText({ ...node, leaders: 12 })).toMatch(/^12/);
  expect(loadText(node)).toBe("—");
});
