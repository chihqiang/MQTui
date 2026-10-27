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
  canReconnect,
  displayName,
  isAutomaticName,
  mergeHistory,
  previewOf,
  secretLabelOf,
  secretStateOf,
} from "./connection-history.ts";

const saved = (id: string, name: string, endpoint: string, savedAt: number) => ({
  id,
  name,
  kind: "kafka",
  endpoint,
  savedAt,
  hasSecret: true,
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
  // 缺口令的点进去先要补口令，不该把一点就回去的记录挤出屏幕。
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

test("一张表：保存过的和只连过的混排，只差口令在不在", () => {
  // 界面不再分「已保存 / 未保存」两段，所以这条不能再靠 savedId 分组，
  // 排序与标记都得能在一张表里读出来。
  const items = mergeHistory(
    [saved("kafka:a", "a", "10.0.0.1:9092", 100)],
    [recent("b", "10.0.0.2:9092", 300), recent("c", "10.0.0.3:9092", 200)],
  );
  assert.deepEqual(
    items.map((item) => [item.name, item.hasSecret, canReconnect(item)]),
    [
      ["a", true, true],
      ["b", false, false],
      ["c", false, false],
    ],
  );
  assert.deepEqual(
    items.map(secretStateOf),
    ["saved", "missing", "missing"],
  );
});

test("保存过但没存口令的记录：能重连这件事不由「存过」决定", () => {
  // 只在向导里存了地址和账号、没存口令 —— 这条记录 savedId 有值，
  // 但点「重连」必定失败，所以它得和「只连过」一样标缺口令。
  const items = mergeHistory(
    [{ ...saved("kafka:a", "a", "10.0.0.1:9092", 1), hasSecret: false }],
    [],
  );
  assert.equal(items[0].savedId, "kafka:a");
  assert.equal(canReconnect(items[0]), false);
  assert.equal(previewOf(items).length, 0);
});

test("没传 hasSecret 的调用方按「有口令」算", () => {
  const items = mergeHistory([saved("kafka:a", "a", "10.0.0.1:9092", 1)], []);
  assert.equal(items[0].hasSecret, true);
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

test("口令标记只看口令，不看有没有账号", () => {
  // 没有账号也不等于「能重连」：Kafka 不开 SASL 时不需要账号，
  // 但只要历史里没存口令，这份配置就不该被说成「已存口令」。
  assert.equal(secretStateOf({ hasSecret: true }), "saved");
  assert.equal(secretStateOf({ hasSecret: false }), "missing");
});

test("不带认证连上的机器：不标缺口令，也不该被问口令", () => {
  // 明文直连的 Kafka 本来就不收口令。把它标成「口令不在本机」，
  // 等于让用户去找一样这台机器根本不要的东西。
  const items = mergeHistory([], [{ ...recent("local", "127.0.0.1:9092", 10), noAuth: true }]);
  assert.equal(items[0].noAuth, true);
  assert.equal(secretStateOf(items[0]), "saved");
  assert.equal(secretLabelOf(items[0]), "重填参数");
});

test("要认证却没存口令的机器：照旧标缺口令", () => {
  const items = mergeHistory([], [{ ...recent("prod", "10.0.1.12:9092", 10), noAuth: false }]);
  assert.equal(secretStateOf(items[0]), "missing");
  assert.equal(secretLabelOf(items[0]), "补口令");
});

test("老记录没有 noAuth 字段时按「要口令」处理", () => {
  // 宁可多问一次，也不敢替人断言「这台不用口令」。
  const items = mergeHistory([], [recent("old", "10.0.1.9:9092", 10)]);
  assert.equal(items[0].noAuth, false);
  assert.equal(secretStateOf(items[0]), "missing");
});

test("保存过的配置：noAuth 与口令两者任一即可重连", () => {
  const plain = {
    ...saved("kafka:local", "local", "127.0.0.1:9092", 1),
    hasSecret: false,
    noAuth: true,
  };
  const items = mergeHistory([plain], []);
  assert.equal(canReconnect(items[0]), true);
});
