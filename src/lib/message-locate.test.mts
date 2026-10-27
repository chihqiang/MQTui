/**
 * 消息定位续扫的纯逻辑校验。
 *
 * `appendPage` 决定「继续扫描」之后列表长什么样：命中要去重、累计计数要正确、
 * 游标要换成新的。这些规则错一条，界面上的数字就会骗人。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import { appendPage, bucketHits, describeScanProgress } from "./locate-result.ts";
import {
  buildLocateRequest,
  completeContentRange,
  formatLocalDateTime,
  parseLocalDateTime,
  shiftContentRange,
} from "./message-locate.ts";

function message(id: string) {
  return {
    id,
    preview: id,
    key: undefined,
    topic: undefined,
    partition: 0,
    offset: 0,
    timestamp: undefined,
    size: 0,
    payload: undefined,
  };
}

function page(ids: string[], scanned: number, cursor?: string) {
  return {
    items: ids.map(message),
    scanned,
    truncated: false,
    note: "",
    cursor,
    resumedFrom: "",
  };
}

test("first page becomes the base result", () => {
  const result = appendPage(undefined, page(["a", "b"], 100, "c1"));
  assert.equal(result.totalHits, 2);
  assert.equal(result.totalScanned, 100);
  assert.equal(result.pages, 0);
  assert.equal(result.cursor, "c1");
});

test("resumed page accumulates counters and replaces cursor", () => {
  const first = appendPage(undefined, page(["a", "b"], 100, "c1"));
  const second = appendPage(first, page(["c"], 80, "c2"));
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(second.totalHits, 3);
  assert.equal(second.totalScanned, 180);
  assert.equal(second.pages, 1);
  // 游标必须是新的那个，否则「继续」会原地打转。
  assert.equal(second.cursor, "c2");
});

test("duplicates at the page boundary are dropped", () => {
  const first = appendPage(undefined, page(["a", "b"], 100, "c1"));
  const second = appendPage(first, page(["b", "c"], 50, "c2"));
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  // 去重后的新增条数是 1，累计命中不能把重复的那条算两次。
  assert.equal(second.totalHits, 3);
});

test("empty page still advances counters and keeps the scanner honest", () => {
  const first = appendPage(undefined, page(["a"], 100, undefined));
  const second = appendPage(first, page([], 400, "c2"));
  assert.equal(second.totalHits, 1);
  assert.equal(second.totalScanned, 500);
  assert.equal(second.items.length, 1);
});

test("no cursor means the scan reached the end", () => {
  const result = appendPage(undefined, page(["a"], 10, undefined));
  assert.equal(result.cursor, undefined);
});


// ---- 内容搜索的时间区间 ----

/** 固定一个本地时间点，避开「跑测试时正好跨小时」带来的抖动。 */
function local(iso: string) {
  return parseLocalDateTime(iso) as number;
}

test("formatLocalDateTime never emits utc (no Z, no offset shift)", () => {
  const text = formatLocalDateTime(local("2026-10-26T09:05"));
  assert.equal(text, "2026-10-26T09:05");
  // 回环：格式化再解析必须得到同一个时刻。
  assert.equal(parseLocalDateTime(text), local("2026-10-26T09:05"));
});

test("content search fills the missing end of the range", () => {
  const onlyBefore = completeContentRange({
    key: "",
    content: "timeout",
    after: "",
    before: "2026-10-26T10:00",
  });
  // 补出等长窗口（默认一小时），让「错误发生前那一小时」真的是一小时。
  assert.equal(onlyBefore.before, "2026-10-26T10:00");
  assert.equal(onlyBefore.after, "2026-10-26T09:00");

  const onlyAfter = completeContentRange({
    key: "",
    content: "timeout",
    after: "2026-10-26T10:00",
    before: "",
  });
  assert.equal(onlyAfter.after, "2026-10-26T10:00");
  assert.equal(onlyAfter.before, "2026-10-26T11:00");
});

test("complete range and non-content forms are left untouched", () => {
  const complete = { key: "", content: "x", after: "2026-10-26T10:00", before: "2026-10-26T11:00" };
  assert.deepEqual(completeContentRange(complete), complete);

  // 只有 key 的定位不该被塞进一个凭空出现的时间区间。
  const keyOnly = { key: "order-1", content: "", after: "", before: "" };
  assert.deepEqual(completeContentRange(keyOnly), keyOnly);
});

test("build request never sends a half-open content range", () => {
  const request = buildLocateRequest(
    "c1",
    "orders",
    { key: "", content: "timeout", after: "", before: "2026-10-26T10:00" },
    200,
  );
  // 两端都在，后端就不可能从日志头开始全量扫。
  assert.equal(request?.after, local("2026-10-26T09:00"));
  assert.equal(request?.before, local("2026-10-26T10:00"));
});

test("shifting the range keeps its length and moves both ends", () => {
  const form = {
    key: "",
    content: "timeout",
    after: "2026-10-26T10:00",
    before: "2026-10-26T10:30",
  };
  const earlier = shiftContentRange(form, "earlier");
  assert.equal(earlier.after, "2026-10-26T09:30");
  assert.equal(earlier.before, "2026-10-26T10:00");

  // 往回挪一次再往前挪一次，应当回到原位。
  const back = shiftContentRange(earlier, "later");
  assert.deepEqual(back, form);
});

test("shifting an unparsable range changes nothing", () => {
  const form = { key: "", content: "x", after: "", before: "" };
  assert.deepEqual(shiftContentRange(form, "earlier"), form);
});

test("buckets only make sense inside a real range", () => {
  // 没有区间就没有「相对位置」，返回空而不是硬切。
  assert.deepEqual(bucketHits([{ timestamp: 100 }], undefined, 1000), []);
  // 倒挂的区间同理。
  assert.deepEqual(bucketHits([{ timestamp: 100 }], 2000, 1000), []);
});

test("buckets count hits per slice and put the edge case last", () => {
  const after = 0;
  const before = 1200;
  const items = [
    { timestamp: 0 },
    { timestamp: 100 }, // 第一段
    { timestamp: 600 }, // 中间
    { timestamp: 1200 }, // 区间末端是闭区间，算最后一段
  ];
  const buckets = bucketHits(items, after, before, 3);
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].hits, 2);
  assert.equal(buckets[2].hits, 1);
  // 无时间戳的消息不参与统计。
  assert.equal(bucketHits([{ timestamp: undefined }], after, before, 3).reduce((sum, b) => sum + b.hits, 0), 0);
});

test("scan progress distinguishes exhausted from resumable", () => {
  const done = describeScanProgress({ scanned: 100, hits: 3, pages: 2, exhausted: true });
  assert.ok(done.includes("区间已读完"), done);
  // 没有游标就是读完了，不该再鼓励用户「继续」。
  assert.ok(!done.includes("还能继续"), done);

  const more = describeScanProgress({ scanned: 100, hits: 3, pages: 0, exhausted: false });
  assert.ok(more.includes("还没读完"), more);
});
