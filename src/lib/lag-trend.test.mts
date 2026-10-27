import { expect, test } from "vitest";

import {
  catchUpNote,
  formatDelta,
  formatRate,
  hasWorsening,
  missingNote,
  notablePartitions,
  summarize,
  trendIsTrustworthy,
  verdictOf,
  verdictText,
  verdictTone,
  windowWarning,
} from "./lag-trend.ts";
import type { LagTrend, PartitionLagProgress } from "../types/lag-trend.ts";

function trend(overrides: Partial<LagTrend> = {}): LagTrend {
  return {
    group: "orders-worker",
    windowMs: 5_000,
    window: "fresh",
    verdict: "catching",
    lagBefore: 10_000,
    lagAfter: 4_000,
    lagDelta: -6_000,
    consumed: 6_000,
    produced: 0,
    consumeRate: 1_200,
    partitions: [],
    ...overrides,
  };
}

function progress(overrides: Partial<PartitionLagProgress> = {}): PartitionLagProgress {
  return {
    topic: "orders",
    partition: 0,
    lagBefore: 100,
    lagAfter: 40,
    lagDelta: -60,
    consumed: 60,
    produced: 0,
    verdict: "catching",
    ...overrides,
  };
}

test("在追与越欠越多用的是相反的说法", () => {
  expect(summarize(trend())).toMatch(/在追/);
  expect(summarize(trend({ verdict: "falling", lagBefore: 0, lagAfter: 900 }))).toMatch(/越欠越多/);
});

test("窗口不可用时先说窗口的问题，不谈趋势", () => {
  const short = summarize(trend({ window: "tooShort", verdict: "catching" }));
  expect(short).toMatch(/挨得太近/);
  expect(short.includes("在追")).toBe(false);
});

test("零滞后持平不能说成持平在 0 条", () => {
  const idle = summarize(trend({ verdict: "flat", lagBefore: 0, lagAfter: 0, lagDelta: 0 }));
  expect(idle).toMatch(/没有积压/);
});

test("位点回退的结论要说明差值不作数", () => {
  expect(summarize(trend({ verdict: "rewound" }))).toMatch(/不作数/);
  expect(windowWarning("invalid")).toBe("两次采样的时间顺序不对，本次不计算趋势");
  expect(trendIsTrustworthy("fresh")).toBe(true);
  expect(trendIsTrustworthy("tooShort")).toBe(false);
});

test("极小的速率不显示成 0.00", () => {
  expect(formatRate(0.004)).toBe("< 0.01 条/秒");
  expect(formatRate(0)).toBe("0 条/秒");
  expect(formatRate(undefined)).toBe("0 条/秒");
  expect(formatRate(1500)).toBe("1,500 条/秒");
});

test("变化量带方向", () => {
  expect(formatDelta(-6000)).toBe("-6,000");
  expect(formatDelta(300)).toBe("+300");
  expect(formatDelta(0)).toBe("0");
});

test("结论与色调一一对应", () => {
  expect(verdictOf("catching").tone).toBe("success");
  expect(verdictOf("falling").tone).toBe("danger");
  expect(verdictOf("rewound").tone).toBe("warning");
  // 后端加了新结论时先原样显示，不要吞掉。
  expect(verdictOf("throttled")).toEqual({ label: "throttled", tone: "neutral" });
});

test("分区判定：恶化最显眼", () => {
  expect(verdictTone("falling")).toBe("danger");
  expect(verdictTone("flat")).toBe("neutral");
  expect(verdictText("rewound")).toBe("位点回退");
});

test("只挑需要看一眼的分区", () => {
  const report = trend({
    partitions: [
      progress(),
      progress({ partition: 1, verdict: "falling" }),
      progress({ partition: 2, verdict: "flat" }),
      progress({ partition: 3, verdict: "rewound" }),
    ],
  });
  expect(hasWorsening(report)).toBe(true);
  expect(notablePartitions(report).map((item) => item.partition)).toEqual([1, 3]);
});

test("分区不齐时要说明，而不是让总数自己解释", () => {
  expect(missingNote(trend())).toBe(undefined);
  expect(missingNote(trend({ missing: ["orders/3"] })) ?? "").toMatch(/orders\/3/);
});

test("追赶速度只在本该追赶时出现", () => {
  expect(catchUpNote(trend())).toBe(undefined);
  expect(catchUpNote(trend({ catchUpRate: 0.14 })) ?? "").toMatch(/再快/);
});
