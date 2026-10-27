/**
 * 命中高亮的纯逻辑校验。
 *
 * 和其余 `.test.mts` 一样走 node 内置的 `node:test`，
 * `npm run test:web` 一并跑。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { splitHighlight } from "./highlight.ts";

test("命中片段被切成三份，保留原文大小写", () => {
  assert.deepEqual(splitHighlight("表格密度改为「宽松」", "密度"), {
    head: "表格",
    hit: "密度",
    tail: "改为「宽松」",
  });
  assert.deepEqual(splitHighlight("Offset Reset", "offset"), {
    head: "",
    hit: "Offset",
    tail: " Reset",
  });
});

test("空查询与未命中都原样返回", () => {
  assert.deepEqual(splitHighlight("概览", ""), { head: "概览", hit: "", tail: "" });
  assert.deepEqual(splitHighlight("概览", "   "), { head: "概览", hit: "", tail: "" });
  // 未命中时不能把整串塞进 head 之外的空档，否则界面会高亮整行。
  assert.deepEqual(splitHighlight("概览", "队列"), { head: "概览", hit: "", tail: "" });
});

test("只切第一处命中", () => {
  const parts = splitHighlight("密度密度", "密度");
  assert.equal(parts.hit, "密度");
  assert.equal(parts.tail, "密度");
});

test("查询词前后空白不影响命中位置", () => {
  assert.deepEqual(splitHighlight("新建连接", " 新建 "), {
    head: "",
    hit: "新建",
    tail: "连接",
  });
});
