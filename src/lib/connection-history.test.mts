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

import {
  HISTORY_PREVIEW,
  brokerPortFor,
  displayName,
  isAutomaticName,
  mergeHistory,
  needsSecret,
  previewOf,
} from "./connection-history.ts";

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

test("预览只挑能重连的那几条", () => {
  // 「连过 · 未保存」点进去先要补口令，不该把一点就回去的记录挤出屏幕。
  const items = mergeHistory(
    [saved("kafka:a", "a", "10.0.0.1:9092", 1)],
    [recent("b", "10.0.0.2:9092", 5), recent("c", "10.0.0.3:9092", 4), recent("d", "10.0.0.4:9092", 3)],
  );
  assert.deepEqual(
    previewOf(items).map((item) => item.name),
    ["a"],
  );
  assert.equal(previewOf(mergeHistory([], [recent("x", "1", 1)])).length, 0);
});

test("预览上限仍是三条", () => {
  const items = mergeHistory(
    [
      saved("kafka:a", "a", "1", 5),
      saved("kafka:b", "b", "2", 4),
      saved("kafka:c", "c", "3", 3),
      saved("kafka:d", "d", "4", 2),
    ],
    [],
  );
  assert.equal(previewOf(items).length, HISTORY_PREVIEW);
});

test("被自动填上的名字不再重复一遍", () => {
  const labels = ["Kafka", "RabbitMQ"];
  // 没填名字 → 回填成中间件本身：那一行读起来是「Kafka · Kafka」。
  assert.equal(displayName({ name: "Kafka", endpoint: "127.0.0.1:9092" }, labels), "");
  assert.equal(displayName({ name: "kafka", endpoint: "127.0.0.1:9092" }, labels), "");
  // 老记录里名字就是主机段。
  assert.equal(displayName({ name: "127.0.0.1", endpoint: "127.0.0.1:9092" }, labels), "");
  // 人起过的名字要留着 —— 哪怕它看着像地址的一部分。
  assert.equal(displayName({ name: "prod", endpoint: "10.0.0.1:9092" }, labels), "prod");
  assert.equal(displayName({ name: "kafka-prod", endpoint: "kafka-prod:9092" }, labels), "kafka-prod");
});

test("自动名字的判据只认两种形态", () => {
  assert.equal(isAutomaticName("  ", "1.2.3.4:9092"), true);
  assert.equal(isAutomaticName("rabbitMq", "1.2.3.4:5672", ["Kafka", "RabbitMQ"]), true);
  assert.equal(isAutomaticName("1.2.3.4", "1.2.3.4:9092"), true);
  // 多个 broker 时看第一段；主机名本身不像地址，就不当成自动名字。
  assert.equal(isAutomaticName("127.0.0.1", "127.0.0.1:9092,10.0.0.2:9092"), true);
  assert.equal(isAutomaticName("a", "a:9092,b:9092"), false);
  assert.equal(isAutomaticName("我的集群", "10.0.0.1:9092"), false);
});

test("历史里没存端口时按中间件的默认口兜", () => {
  assert.equal(brokerPortFor("kafka", "10.0.0.1:9092"), 9092);
  assert.equal(brokerPortFor("rabbitMq", "rabbit:5673"), 5673);
  // 15672 是管理界面的口，敲它连不上 AMQP；取不到就用 5672。
  assert.equal(brokerPortFor("rabbitMq", "rabbit"), 5672);
  assert.equal(brokerPortFor("kafka", "broker 没有端口"), 9092);
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
