import { expect, test } from "vitest";

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
  expect(verdictTone(report({ blocked: true }))).toBe("danger");
  // 整组没动只是观察，半夜没流量时滞后本来就不变。
  expect(verdictTone(report({ idle: true }))).toBe("warning");
  expect(verdictTone(report())).toBe("success");
});

test("阻塞标题带上分区数与积压量", () => {
  const text = headline(report({ blocked: true, stuck: [stuck] }));
  expect(text).toMatch(/1 个分区/);
  expect(text).toMatch(/1,200/);
});

test("拿不到归属时写未知而不是留空", () => {
  expect(memberText(stuck)).toBe("worker-2");
  expect(memberText({ ...stuck, members: [] })).toBe("未知");
  expect(memberText({ ...stuck, members: undefined })).toBe("未知");
});

test("分区标识用 topic-分区号，与后端位点对得上", () => {
  expect(stuckLabel(stuck)).toBe("orders-3");
});

test("建议只在有问题时给，避免正确的结论也挂着废话", () => {
  expect(advice(report({ blocked: true })) ?? "").toMatch(/毒消息/);
  expect(advice(report({ idle: true, stuck: [stuck] })) ?? "").toMatch(/上游/);
  expect(advice(report())).toBe(undefined);
});

test("位点回退的分区单独列出来，不让它污染结论", () => {
  expect(regressedText(report())).toBe(undefined);
  expect(regressedText(report({ regressed: ["orders-0"] })) ?? "").toMatch(/orders-0/);
});
