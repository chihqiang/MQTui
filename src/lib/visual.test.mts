/**
 * 视觉语言的规则测试。
 *
 * 这几条错了都不会崩：只是界面看着散、或者一启动就降级。
 * 正因为不报错，才需要钉住。
 */

import { expect, test } from "vitest";

import { NARROW_WIDTH } from "./layout.ts";
import {
  DEFAULT_STATUS_DENSITY,
  DEFAULT_WINDOW_SIZE,
  META_FONT_SIZE,
  MIN_WINDOW_SIZE,
  TEXT_SIZE_CLASS,
  brokerIdentity,
  brokerMark,
  brokerTone,
  fitsLayout,
  initialWindowSize,
  isSemanticTone,
  metaFontSize,
  statusBarHeight,
  textSize,
} from "./visual.ts";

test("默认窗口放得下侧栏，不会一启动就降级", () => {
  expect(fitsLayout(DEFAULT_WINDOW_SIZE.width, NARROW_WIDTH)).toBe(true);
  // 回归：曾经是 800×600，比自家阈值 900 还小，首屏永远是降级档。
  expect(DEFAULT_WINDOW_SIZE.width > NARROW_WIDTH).toBeTruthy();
});

test("默认窗口放得进 1440×900 的笔记本屏", () => {
  // 标题栏 + 任务栏大约吃掉 80px 纵向，横向留边。
  expect(DEFAULT_WINDOW_SIZE.width <= 1360).toBeTruthy();
  expect(DEFAULT_WINDOW_SIZE.height <= 820).toBeTruthy();
});

test("最小窗口小于默认值，且仍能排出两列", () => {
  expect(MIN_WINDOW_SIZE.width < DEFAULT_WINDOW_SIZE.width).toBeTruthy();
  expect(MIN_WINDOW_SIZE.height < DEFAULT_WINDOW_SIZE.height).toBeTruthy();
  expect(MIN_WINDOW_SIZE.width >= 640).toBeTruthy();
});

test("初始尺寸是一份拷贝，调用方改它不会污染常量", () => {
  const size = initialWindowSize();
  size.width = 1;
  expect(DEFAULT_WINDOW_SIZE.width).toBe(1280);
});

test("五档字号各有类名，且互不相同", () => {
  const values = Object.values(TEXT_SIZE_CLASS);
  expect(new Set(values).size).toBe(values.length);
  expect(Object.keys(TEXT_SIZE_CLASS).length).toBe(5);
  expect(textSize("display")).toBe(TEXT_SIZE_CLASS.display);
  // micro 是「不读只认」的一档，必须比 meta 更小才有存在意义。
  expect(TEXT_SIZE_CLASS.micro.includes("micro")).toBe(true);
});

test("中间件身份色不看告警语义", () => {
  expect(brokerIdentity("kafka")).toBe("kafka");
  expect(brokerIdentity("rabbitMq")).toBe("rabbitmq");
  expect(brokerIdentity("nats")).toBe("unknown");
});

test("RabbitMQ 的身份色不是告警色", () => {
  // 回归：曾经是 warning(amber)，扫读时会被误判成「这个连接有问题」。
  expect(brokerTone("rabbitMq")).not.toBe("warning");
  expect(brokerTone("kafka")).not.toBe("warning");
  expect(brokerTone("kafka")).not.toBe(brokerTone("rabbitMq"));
  expect(brokerTone("nats")).toBe("neutral");
});

test("身份色不落在任何语义色上", () => {
  // 两次返工都出在这里：借 amber 被读成「有问题」，借 sky 又与「信息」撞脸。
  for (const kind of ["kafka", "rabbitMq"]) {
    const tone = brokerTone(kind);
    // 第二个参数是失败时的说明，与 node:assert 的写法一致。
    expect(isSemanticTone(tone), `${kind} 的身份色 ${tone} 撞了语义色`).toBe(false);
  }
  expect(isSemanticTone("info")).toBe(true);
  expect(isSemanticTone("warning")).toBe(true);
});

test("次级字号只有一档，界面不因偏好而变形", () => {
  expect(metaFontSize()).toBe(`${META_FONT_SIZE}px`);
});

test("次级字号明显小于正文，又大于「只认不读」的微档", () => {
  // 12.5px：12px 在 13 寸高分屏缩放下会糊，13px 又和 14px 正文抢读。
  expect(META_FONT_SIZE).toBe(12.5);
});

test("状态条紧凑档比宽松档薄，且不为 0", () => {
  expect(statusBarHeight(DEFAULT_STATUS_DENSITY) > 0).toBeTruthy();
  expect(statusBarHeight("compact") < statusBarHeight("comfortable")).toBeTruthy();
});

test("两种中间件的品牌形状不同，未知类型不冒充品牌", () => {
  // 图标是「这是哪种中间件」的第一识别物。两个形状要是同一个，徽标就退化成
  // 只是「颜色不一样」—— 那得先记住颜色才用得上。
  expect(brokerMark("kafka")).toBe("kafka");
  expect(brokerMark("rabbitMq")).toBe("rabbitmq");
  expect(brokerMark("kafka")).not.toBe(brokerMark("rabbitMq"));
  // 未知类型给 unknown，调用方画通用图标而不是随便借一个品牌形状。
  expect(brokerMark("pulsar")).toBe("unknown");
});
