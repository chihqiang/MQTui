/** 集群页展示逻辑的补充单测：只看需处理、占比条颜色、承载文案。 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { barTone, loadText, needsAttention } from "./cluster.ts";
import type { ClusterNode, NodeStat } from "../types/cluster.ts";

const node: ClusterNode = { name: "n1", role: "member", roleLabel: "成员", running: true };

test("不运行的节点必须留下", () => {
  assert.equal(needsAttention({ ...node, running: false }, undefined), true);
  assert.equal(needsAttention(node, undefined), false);
});

test("后端标了 attention 的节点留下", () => {
  assert.equal(needsAttention(node, { name: "n1", headline: "", detail: "", attention: true }), true);
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
  assert.equal(barTone(stat), "success");
});

test("两种中间件的承载文案不同", () => {
  assert.match(loadText({ ...node, queues: 12 }), /队列/);
  assert.match(loadText({ ...node, leaders: 12 }), /^12/);
  assert.equal(loadText(node), "—");
});
