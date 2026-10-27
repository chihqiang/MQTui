/**
 * 历史聚合的测试。
 *
 * 这里错了不会崩，但会让「我明明连过」的那台机器从首页上消失 —— 而那正是
 * 用户唯一想找的东西，所以逐条钉住。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { HISTORY_PREVIEW, mergeHistory, needsSecret, previewOf } from "./connection-history.ts";

const saved = (id: string, name: string, endpoint: string, savedAt: number) => ({
  id,
  name,
  kind: "kafka",
  endpoint,
  savedAt,
});

const recent = (name: string, endpoint: string, usedAt: number) => ({
  name,
  kind: "kafka",
  endpoint,
  usedAt,
});

test("只连过没保存的连接也要出现在历史里", () => {
  const items = mergeHistory([], [recent("kafka-prod", "10.0.1.12:9092", 100)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].savedId, null);
  assert.equal(items[0].endpoint, "10.0.1.12:9092");
});

test("同一台机器连过又保存过，只留一条且可重连", () => {
  const items = mergeHistory(
    [saved("kafka:prod", "prod", "10.0.1.12:9092", 100)],
    [recent("prod", "10.0.1.12:9092", 200)],
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].savedId, "kafka:prod");
  // 时间抬到最近一次连接：保存很久之后再连，它仍该排在新记录前面。
  assert.equal(items[0].at, 200);
});

test("能重连的排在前面，组内按时间倒序", () => {
  const items = mergeHistory(
    [saved("kafka:a", "a", "10.0.0.1:9092", 100)],
    [recent("b", "10.0.0.2:9092", 300), recent("c", "10.0.0.3:9092", 200)],
  );
  assert.deepEqual(
    items.map((item) => item.name),
    ["a", "b", "c"],
  );
});

test("判重按 kind + endpoint，不按名字", () => {
  const items = mergeHistory(
    [saved("kafka:x", "旧名字", "10.0.0.1:9092", 100)],
    [recent("新名字", "10.0.0.1:9092", 200)],
  );
  assert.equal(items.length, 1);
  // 名字以保存的记录为准：那才是用户点「重连」时会看到的那一条。
  assert.equal(items[0].name, "旧名字");
});

test("只预览前三条", () => {
  const items = mergeHistory([], [
    recent("a", "1", 5),
    recent("b", "2", 4),
    recent("c", "3", 3),
    recent("d", "4", 2),
  ]);
  assert.equal(previewOf(items).length, HISTORY_PREVIEW);
  assert.deepEqual(
    previewOf(items).map((item) => item.name),
    ["a", "b", "c"],
  );
});

test("有账号没口令的记录算「缺口令」", () => {
  const entry = (username?: string, password?: string) => ({
    config: { kind: "kafka", auth: { username, password } },
  });
  assert.equal(needsSecret(entry("admin", undefined)), true);
  assert.equal(needsSecret(entry("admin", "")), true);
  assert.equal(needsSecret(entry("admin", "secret")), false);
  assert.equal(needsSecret(entry(undefined, undefined)), false);
});
