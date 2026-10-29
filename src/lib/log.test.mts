import { expect, test } from "vitest";

import { argsSummary, tookText } from "./log.ts";

test("参数摘要只留长度与数量，不落原始内容", () => {
  expect(argsSummary()).toBe("无参数");
  expect(argsSummary({})).toBe("无参数");
  expect(argsSummary({ id: "abc", name: "连接 A" })).toBe("id=3 字符, name=4 字符");
  expect(argsSummary({ payload: "xxxxx", headers: [1, 2] })).toBe(
    "payload=5 字符, headers=2 项",
  );
  expect(argsSummary({ spec: { topic: "t" }, dryRun: true })).toBe(
    "spec={…}, dryRun=true",
  );
});

test("耗时按毫秒与秒分档", () => {
  expect(tookText(0, 0)).toBe("0ms");
  expect(tookText(0, 999)).toBe("999ms");
  expect(tookText(0, 1500)).toBe("1.50s");
});
