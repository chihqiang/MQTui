/** 孤儿主题页纯逻辑的单测：范围摘要与堆积阈值。 */

import { expect, test } from "vitest";

import { describeScope, orphanTone } from "./orphan-topics.ts";

test("什么都没选时是全量扫描", () => {
  expect(describeScope({})).toBe("全量扫描");
  expect(describeScope({ topics: [], prefix: "  " })).toBe("全量扫描");
});

test("主题与前缀同时存在时要都说出来", () => {
  expect(describeScope({ topics: ["a", "b"], prefix: "order." })).toBe("2 个主题 + 前缀 order.");
});

test("堆积越阈就转警示与危险", () => {
  expect(orphanTone(0)).toBe("neutral");
  expect(orphanTone(999)).toBe("neutral");
  expect(orphanTone(1_000)).toBe("warning");
  expect(orphanTone(10_000)).toBe("danger");
});
