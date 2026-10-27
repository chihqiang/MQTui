/**
 * 监控页布局规则的测试。
 *
 * 这几条全是「做反了不报错」的类型：占比写成 0%、筛选为空时只说「没有数据」、
 * 列数算错导致卡片塌成一列 —— 都不会崩，只是界面在撒谎。
 */

import { expect, test } from "vitest";

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
  expect(splitColumns(0, 320, 3)).toBe(1);
  expect(splitColumns(-100, 320, 3)).toBe(1);
  // 最小列数是 2 时也不该塌成 1。
  expect(splitColumns(0, 320, 3, 2)).toBe(2);
});

test("列数落在 min..max 之间", () => {
  expect(splitColumns(320, 320, 3)).toBe(1);
  expect(splitColumns(700, 320, 3)).toBe(2);
  expect(splitColumns(2000, 320, 3)).toBe(3);
  // 单卡最小宽度为 0 是配置错误，不该除出 Infinity。
  expect(splitColumns(800, 0, 3)).toBe(1);
});

test("筛选说明两个方向都读得通", () => {
  expect(describeScope(0, 0)).toBe("没有可显示的数据");
  expect(describeScope(3, 3)).toBe("共 3 条");
  expect(describeScope(1, 3)).toBe("共 3 条 · 显示 1 条");
  expect(describeScope(3, 3, "个队列")).toBe("共 3 个队列");
});

test("没有数据 / 全被筛掉 / 全绿 三种空态互不相同", () => {
  expect(scopeVerdict(0, 0)).toBe("empty");
  expect(scopeVerdict(0, 5)).toBe("filtered-out");
  expect(scopeVerdict(2, 5)).toBe("has-items");
});

test("占比上限未知时返回 null，不返回 0", () => {
  // 老版本管理 API 不报 mem_limit：把「没上报」画成「很空」是这类面板最典型的骗人方式。
  expect(ratio(100, 0)).toBe(null);
  expect(ratio(0, 0)).toBe(null);
  expect(ratioText(100, 0)).toBe("未知");
  expect(ratioText(0, 0)).toBe("未知");
});

test("占比收敛到 0..1", () => {
  expect(ratio(50, 100)).toBe(0.5);
  expect(ratio(150, 100)).toBe(1);
  expect(ratio(-5, 100)).toBe(0);
  expect(ratioText(1, 3)).toBe("33%");
});

test("按列填充时纵向连续，且不丢条目", () => {
  const columns = chunkColumns([1, 2, 3, 4, 5], 2);
  expect(columns.length).toBe(2);
  expect(columns.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  // 3 行 2 列：第一列是 1/2/3，第二列是 4/5。
  expect(columns).toEqual([[1, 2, 3], [4, 5]]);
});

test("列数为 0 或空列表时不崩", () => {
  expect(chunkColumns([1, 2], 0)).toEqual([[1, 2]]);
  expect(chunkColumns([], 3)).toEqual([[], [], []]);
});

// —— 中间件的身份色 ————————————————————————————————————————————

test("身份色只认已知中间件，未知的一律不标", () => {
  expect(brokerBadgeTone("kafka")).toBe("broker-kafka");
  expect(brokerBadgeTone("rabbitMq")).toBe("broker-rabbitmq");
  expect(brokerBadgeTone(undefined)).toBe(null);
  expect(brokerBadgeTone("nats")).toBe(null);
  expect(brokerBadgeLabel("nats")).toBe(null);
});

test("身份色不许借用任何语义色", () => {
  // 回归两次：RabbitMQ 曾用 warning(amber)，像「这个连接有问题」；
  // 之后 Kafka 又借了 info(sky)，于是「这是 Kafka」和「这是一条提示」同色。
  const tones = [brokerBadgeTone("kafka"), brokerBadgeTone("rabbitMq")];
  for (const tone of tones) {
    expect(["info", "success", "warning", "danger"].includes(tone as string)).toBe(false);
  }
  expect(brokerBadgeTone("kafka")).not.toBe(brokerBadgeTone("rabbitMq"));
});
