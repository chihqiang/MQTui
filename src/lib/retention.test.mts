// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  RETENTION_KEY,
  describeRetention,
  describeRetentionPlan,
  parseRetentionMs,
  retentionChanges,
  retentionIssue,
  summarizeRetention,
} from "./retention.ts";

test("选了档位就直接用它", () => {
  assert.equal(parseRetentionMs({ action: { kind: "set", ms: 3600000 }, custom: "" }), 3600000);
  assert.equal(retentionIssue({ action: { kind: "set", ms: -1 }, custom: "" }), null);
});

test("手填的值优先于档位", () => {
  assert.equal(parseRetentionMs({ action: { kind: "set", ms: 3600000 }, custom: "1234" }), 1234);
});

test("0 与小于 -1 的值都不接受", () => {
  assert.equal(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "0" }), null);
  assert.ok(retentionIssue({ action: { kind: "set", ms: 1 }, custom: "0" }));
  assert.equal(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "-2" }), null);
  assert.equal(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "-1" }), -1);
});

test("非整数输入给出可读原因", () => {
  assert.ok(retentionIssue({ action: { kind: "set", ms: 1 }, custom: "7d" }));
  assert.equal(parseRetentionMs({ action: { kind: "set", ms: 1 }, custom: "1.5" }), null);
  assert.equal(retentionIssue({ action: { kind: "clear" }, custom: "" }), null);
});

test("批量变更按主题数展开，键名固定", () => {
  const changes = retentionChanges(["a", "b"], { action: { kind: "set", ms: 604800000 }, custom: "" });
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0], { key: RETENTION_KEY, value: "604800000" });
  assert.deepEqual(retentionChanges([], { action: { kind: "set", ms: 1 }, custom: "" }), []);
  assert.deepEqual(retentionChanges(["a"], { action: { kind: "set", ms: 1 }, custom: "0" }), []);
});

test("毫秒转人话", () => {
  assert.equal(describeRetention(-1), "永久（-1）");
  assert.equal(describeRetention(604800000), "7 天");
  assert.equal(describeRetention(7200000), "2 小时");
  assert.equal(describeRetention(1500), "1500 毫秒");
});

test("确认文案点名主题数与后果，并提到被跳过的内部主题", () => {
  const lines = describeRetentionPlan({
    targets: ["a", "b"],
    input: { action: { kind: "set", ms: 604800000 }, custom: "" },
    skipped: ["__consumer_offsets"],
  });
  assert.match(lines[0], /2 个主题/);
  assert.match(lines[0], /7 天/);
  assert.ok(lines.some((line) => line.includes("__consumer_offsets")));
  assert.ok(lines.some((line) => line.includes("不会回滚")));
});

test("结果汇总把失败的主题名字摆出来", () => {
  const ok = summarizeRetention([
    { topic: "a", ok: true, detail: "" },
    { topic: "b", ok: true, detail: "" },
  ]);
  assert.equal(ok.failed, 0);
  assert.equal(ok.text, "已更新 2 个主题的保留时长");

  const mixed = summarizeRetention([
    { topic: "a", ok: true, detail: "" },
    { topic: "b", ok: false, detail: "not authorized" },
  ]);
  assert.equal(mixed.ok, 1);
  assert.equal(mixed.failed, 1);
  assert.match(mixed.text, /b（not authorized）/);
});
