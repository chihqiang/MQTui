/**
 * 监控页布局规则的测试。
 *
 * 这几条全是「做反了不报错」的类型：占比写成 0%、筛选为空时只说「没有数据」、
 * 列数算错导致卡片塌成一列 —— 都不会崩，只是界面在撒谎。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import {
  brokerBadgeLabel,
  brokerBadgeTone,
  chunkColumns,
  describeScope,
  ratio,
  ratioText,
  scopeVerdict,
  splitColumns,
} from "./monitor-layout.ts";

test("宽度未知时按最小列数渲染，不做猜测", () => {
  assert.equal(splitColumns(0, 320, 3), 1);
  assert.equal(splitColumns(-100, 320, 3), 1);
  // 最小列数是 2 时也不该塌成 1。
  assert.equal(splitColumns(0, 320, 3, 2), 2);
});

test("列数落在 min..max 之间", () => {
  assert.equal(splitColumns(320, 320, 3), 1);
  assert.equal(splitColumns(700, 320, 3), 2);
  assert.equal(splitColumns(2000, 320, 3), 3);
  // 单卡最小宽度为 0 是配置错误，不该除出 Infinity。
  assert.equal(splitColumns(800, 0, 3), 1);
});

test("筛选说明两个方向都读得通", () => {
  assert.equal(describeScope(0, 0), "没有可显示的数据");
  assert.equal(describeScope(3, 3), "共 3 条");
  assert.equal(describeScope(1, 3), "共 3 条 · 显示 1 条");
  assert.equal(describeScope(3, 3, "个队列"), "共 3 个队列");
});

test("没有数据 / 全被筛掉 / 全绿 三种空态互不相同", () => {
  assert.equal(scopeVerdict(0, 0), "empty");
  assert.equal(scopeVerdict(0, 5), "filtered-out");
  assert.equal(scopeVerdict(2, 5), "has-items");
});

test("占比上限未知时返回 null，不返回 0", () => {
  // 老版本管理 API 不报 mem_limit：把「没上报」画成「很空」是这类面板最典型的骗人方式。
  assert.equal(ratio(100, 0), null);
  assert.equal(ratio(0, 0), null);
  assert.equal(ratioText(100, 0), "未知");
  assert.equal(ratioText(0, 0), "未知");
});

test("占比收敛到 0..1", () => {
  assert.equal(ratio(50, 100), 0.5);
  assert.equal(ratio(150, 100), 1);
  assert.equal(ratio(-5, 100), 0);
  assert.equal(ratioText(1, 3), "33%");
});

test("按列填充时纵向连续，且不丢条目", () => {
  const columns = chunkColumns([1, 2, 3, 4, 5], 2);
  assert.equal(columns.length, 2);
  assert.deepEqual(
    columns.flat().sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  );
  // 3 行 2 列：第一列是 1/2/3，第二列是 4/5。
  assert.deepEqual(columns, [[1, 2, 3], [4, 5]]);
});

test("列数为 0 或空列表时不崩", () => {
  assert.deepEqual(chunkColumns([1, 2], 0), [[1, 2]]);
  assert.deepEqual(chunkColumns([], 3), [[], [], []]);
});

// —— 中间件的身份色 ————————————————————————————————————————————

test("身份色只认已知中间件，未知的一律不标", () => {
  assert.equal(brokerBadgeTone("kafka"), "broker-kafka");
  assert.equal(brokerBadgeTone("rabbitMq"), "broker-rabbitmq");
  assert.equal(brokerBadgeTone(undefined), null);
  assert.equal(brokerBadgeTone("nats"), null);
  assert.equal(brokerBadgeLabel("nats"), null);
});

test("身份色不许借用任何语义色", () => {
  // 回归两次：RabbitMQ 曾用 warning(amber)，像「这个连接有问题」；
  // 之后 Kafka 又借了 info(sky)，于是「这是 Kafka」和「这是一条提示」同色。
  const tones = [brokerBadgeTone("kafka"), brokerBadgeTone("rabbitMq")];
  for (const tone of tones) {
    assert.ok(!["info", "success", "warning", "danger"].includes(tone as string), String(tone));
  }
  assert.notEqual(brokerBadgeTone("kafka"), brokerBadgeTone("rabbitMq"));
});
