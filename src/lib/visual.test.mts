/**
 * 视觉语言的规则测试。
 *
 * 这几条错了都不会崩：只是界面看着散、或者一启动就降级。
 * 正因为不报错，才需要钉住。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { NARROW_WIDTH } from "./layout.ts";
import {
  DEFAULT_META_SCALE,
  DEFAULT_STATUS_DENSITY,
  DEFAULT_WINDOW_SIZE,
  META_FONT_SIZE,
  MIN_WINDOW_SIZE,
  TEXT_SIZE_CLASS,
  brokerIdentity,
  brokerTone,
  fitsLayout,
  initialWindowSize,
  isMetaScale,
  isSemanticTone,
  metaFontSize,
  statusBarHeight,
  textSize,
} from "./visual.ts";

test("默认窗口放得下分组档，不会一启动就降级", () => {
  assert.equal(fitsLayout(DEFAULT_WINDOW_SIZE.width, NARROW_WIDTH), true);
  // 回归：曾经是 800×600，比自家阈值 900 还小，首屏永远是极简档。
  assert.ok(DEFAULT_WINDOW_SIZE.width > NARROW_WIDTH);
});

test("默认窗口放得进 1440×900 的笔记本屏", () => {
  // 标题栏 + 任务栏大约吃掉 100px 纵向，横向留边。
  assert.ok(DEFAULT_WINDOW_SIZE.width <= 1360);
  assert.ok(DEFAULT_WINDOW_SIZE.height <= 800);
});

test("最小窗口小于默认值，且仍能排出两列", () => {
  assert.ok(MIN_WINDOW_SIZE.width < DEFAULT_WINDOW_SIZE.width);
  assert.ok(MIN_WINDOW_SIZE.height < DEFAULT_WINDOW_SIZE.height);
  assert.ok(MIN_WINDOW_SIZE.width >= 640);
});

test("初始尺寸是一份拷贝，调用方改它不会污染常量", () => {
  const size = initialWindowSize();
  size.width = 1;
  assert.equal(DEFAULT_WINDOW_SIZE.width, 1200);
});

test("五档字号各有类名，且互不相同", () => {
  const values = Object.values(TEXT_SIZE_CLASS);
  assert.equal(new Set(values).size, values.length);
  assert.equal(Object.keys(TEXT_SIZE_CLASS).length, 5);
  assert.equal(textSize("display"), TEXT_SIZE_CLASS.display);
  // micro 是「不读只认」的一档，必须比 meta 更小才有存在意义。
  assert.equal(TEXT_SIZE_CLASS.micro.includes("micro"), true);
});

test("中间件身份色不看告警语义", () => {
  assert.equal(brokerIdentity("kafka"), "kafka");
  assert.equal(brokerIdentity("rabbitMq"), "rabbitmq");
  assert.equal(brokerIdentity("nats"), "unknown");
});

test("RabbitMQ 的身份色不是告警色", () => {
  // 回归：曾经是 warning(amber)，扫读时会被误判成「这个连接有问题」。
  assert.notEqual(brokerTone("rabbitMq"), "warning");
  assert.notEqual(brokerTone("kafka"), "warning");
  assert.notEqual(brokerTone("kafka"), brokerTone("rabbitMq"));
  assert.equal(brokerTone("nats"), "neutral");
});

test("身份色不落在任何语义色上", () => {
  // 两次返工都出在这里：借 amber 被读成「有问题」，借 sky 又与「信息」撞脸。
  for (const kind of ["kafka", "rabbitMq"]) {
    const tone = brokerTone(kind);
    assert.equal(isSemanticTone(tone), false, `${kind} 的身份色 ${tone} 撞了语义色`);
  }
  assert.equal(isSemanticTone("info"), true);
  assert.equal(isSemanticTone("warning"), true);
});

test("次级字号两档：默认保持 11px，另一档更大", () => {
  assert.equal(metaFontSize(DEFAULT_META_SCALE), "11px");
  assert.ok(META_FONT_SIZE.normal > META_FONT_SIZE.dense);
  assert.equal(metaFontSize("normal"), "12px");
});

test("字号档位校验挡住脏数据", () => {
  assert.equal(isMetaScale("normal"), true);
  assert.equal(isMetaScale("huge"), false);
  assert.equal(isMetaScale(undefined), false);
});

test("状态条紧凑档比宽松档薄，且不为 0", () => {
  assert.ok(statusBarHeight(DEFAULT_STATUS_DENSITY) > 0);
  assert.ok(statusBarHeight("compact") < statusBarHeight("comfortable"));
});
