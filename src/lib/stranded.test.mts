/**
 * 「没放回队列的那批消息」的单测。
 *
 * 这几条错了都不会崩：按钮照显示、请求照发，只是「点了没反应」或
 * 「点了把用户没选中的消息投出去了」。所以用测试钉住。
 */

import { expect, test } from "vitest";

import {
  canRetryStranded,
  strandedRetryRequest,
  uniqueStranded,
} from "./stranded.ts";

test("只有真的卡住了才给重试入口", () => {
  // 没卡住：不该出现按钮。这是「0 条却亮着按钮」那条老毛病。
  expect(canRetryStranded(undefined)).toBe(false);
  expect(canRetryStranded({})).toBe(false);
  expect(canRetryStranded({ stranded: [] })).toBe(false);

  // 卡住了就有入口。
  expect(canRetryStranded({ stranded: ["orders:7"] })).toBe(true);
  // 后端老版本不带 retryable：按能给处理。
  expect(canRetryStranded({ stranded: ["orders:7"], retryable: true })).toBe(true);

  // 明确说了点不动，就别给一个按下去必然失败的按钮。
  expect(canRetryStranded({ stranded: ["orders:7"], retryable: false })).toBe(false);
});

test("重试请求原样带回那批 ID，不重新算", () => {
  // 关键：卡住的是用户**没选中**的消息，不能被「现在选中的那几条」顶替。
  const request = strandedRetryRequest(
    { stranded: ["orders:7", "orders:3"] },
    { action: "redeliver", queue: "orders", exchange: "", routingKey: "" }
  );
  expect(request?.messageIds).toEqual(["orders:7", "orders:3"]);
  expect(request?.queue).toBe("orders");
  expect(request?.action).toBe("redeliver");
});

test("缺队列时不给请求", () => {
  // 队列推不出来（选中集已清空），此时发出去的请求必然是错的。
  expect(strandedRetryRequest({ stranded: ["orders:7"] }, {
      action: "redeliver",
      queue: "  ",
      exchange: "",
      routingKey: "",
    })).toBe(null);
  expect(strandedRetryRequest(undefined, {
      action: "redeliver",
      queue: "orders",
      exchange: "",
      routingKey: "",
    })).toBe(null);
});

test("重复 ID 只留一份", () => {
  // 重复的 ID 会进两次重试请求，第二次必然找不到、报一条让人困惑的失败。
  expect(uniqueStranded({ stranded: ["orders:7", "orders:7", " ", "orders:3"] })).toEqual([
    "orders:7",
    "orders:3",
  ]);
  expect(uniqueStranded(undefined)).toEqual([]);
});
