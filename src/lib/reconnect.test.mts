import { expect, test } from "vitest";

import { disconnectLabel, isEntryBusy, reconnectLabel } from "./reconnect.ts";

test("只有被点的那一条算忙碌", () => {
  expect(isEntryBusy("a", "a")).toBe(true);
  expect(isEntryBusy("a", "b")).toBe(false);
  expect(isEntryBusy("a", null)).toBe(false);
});

test("忙碌时文案说明是哪一条在连", () => {
  expect(reconnectLabel("kafka-prod", true)).toBe("正在连接 kafka-prod");
  expect(reconnectLabel("kafka-prod", false)).toBe("重连");
});

test("断开时同样说明断的是哪一条", () => {
  expect(disconnectLabel("kafka-prod", false)).toBe("断开 kafka-prod");
  expect(disconnectLabel("kafka-prod", true)).toBe("正在断开 kafka-prod");
});
