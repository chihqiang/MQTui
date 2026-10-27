// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  advice,
  headline,
  memberText,
  regressedText,
  stuckLabel,
  verdictTone,
} from "./group-block.ts";
import type { BlockReport, StuckPartition } from "../types/group-block.ts";

function report(patch: Partial<BlockReport> = {}): BlockReport {
  return {
    blocked: false,
    headline: "没有队头阻塞",
    detail: "",
    stuck: [],
    idle: false,
    regressed: [],
    ...patch,
  };
}

const stuck: StuckPartition = { topic: "orders", partition: 3, lag: 1200, members: ["worker-2"] };

test("只有确认阻塞才用危险色", () => {
  assert.equal(verdictTone(report({ blocked: true })), "danger");
  // 整组没动只是观察，半夜没流量时滞后本来就不变。
  assert.equal(verdictTone(report({ idle: true })), "warning");
  assert.equal(verdictTone(report()), "success");
});

test("阻塞标题带上分区数与积压量", () => {
  const text = headline(report({ blocked: true, stuck: [stuck] }));
  assert.match(text, /1 个分区/);
  assert.match(text, /1,200/);
});

test("拿不到归属时写未知而不是留空", () => {
  assert.equal(memberText(stuck), "worker-2");
  assert.equal(memberText({ ...stuck, members: [] }), "未知");
  assert.equal(memberText({ ...stuck, members: undefined }), "未知");
});

test("分区标识用 topic-分区号，与后端位点对得上", () => {
  assert.equal(stuckLabel(stuck), "orders-3");
});

test("建议只在有问题时给，避免正确的结论也挂着废话", () => {
  assert.match(advice(report({ blocked: true })) ?? "", /毒消息/);
  assert.match(advice(report({ idle: true, stuck: [stuck] })) ?? "", /上游/);
  assert.equal(advice(report()), undefined);
});

test("位点回退的分区单独列出来，不让它污染结论", () => {
  assert.equal(regressedText(report()), undefined);
  assert.match(regressedText(report({ regressed: ["orders-0"] })) ?? "", /orders-0/);
});
