// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import test from "node:test";

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
  assert.match(summarize(trend()), /在追/);
  assert.match(
    summarize(trend({ verdict: "falling", lagBefore: 0, lagAfter: 900 })),
    /越欠越多/,
  );
});

test("窗口不可用时先说窗口的问题，不谈趋势", () => {
  const short = summarize(trend({ window: "tooShort", verdict: "catching" }));
  assert.match(short, /挨得太近/);
  assert.ok(!short.includes("在追"));
});

test("零滞后持平不能说成持平在 0 条", () => {
  const idle = summarize(trend({ verdict: "flat", lagBefore: 0, lagAfter: 0, lagDelta: 0 }));
  assert.match(idle, /没有积压/);
});

test("位点回退的结论要说明差值不作数", () => {
  assert.match(summarize(trend({ verdict: "rewound" })), /不作数/);
  assert.equal(windowWarning("invalid"), "两次采样的时间顺序不对，本次不计算趋势");
  assert.equal(trendIsTrustworthy("fresh"), true);
  assert.equal(trendIsTrustworthy("tooShort"), false);
});

test("极小的速率不显示成 0.00", () => {
  assert.equal(formatRate(0.004), "< 0.01 条/秒");
  assert.equal(formatRate(0), "0 条/秒");
  assert.equal(formatRate(undefined), "0 条/秒");
  assert.equal(formatRate(1500), "1,500 条/秒");
});

test("变化量带方向", () => {
  assert.equal(formatDelta(-6000), "-6,000");
  assert.equal(formatDelta(300), "+300");
  assert.equal(formatDelta(0), "0");
});

test("结论与色调一一对应", () => {
  assert.equal(verdictOf("catching").tone, "success");
  assert.equal(verdictOf("falling").tone, "danger");
  assert.equal(verdictOf("rewound").tone, "warning");
  // 后端加了新结论时先原样显示，不要吞掉。
  assert.deepEqual(verdictOf("throttled"), { label: "throttled", tone: "neutral" });
});

test("分区判定：恶化最显眼", () => {
  assert.equal(verdictTone("falling"), "danger");
  assert.equal(verdictTone("flat"), "neutral");
  assert.equal(verdictText("rewound"), "位点回退");
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
  assert.equal(hasWorsening(report), true);
  assert.deepEqual(
    notablePartitions(report).map((item) => item.partition),
    [1, 3],
  );
});

test("分区不齐时要说明，而不是让总数自己解释", () => {
  assert.equal(missingNote(trend()), undefined);
  assert.match(
    missingNote(trend({ missing: ["orders/3"] })) ?? "",
    /orders\/3/,
  );
});

test("追赶速度只在本该追赶时出现", () => {
  assert.equal(catchUpNote(trend()), undefined);
  assert.match(
    catchUpNote(trend({ catchUpRate: 0.14 })) ?? "",
    /再快/,
  );
});
