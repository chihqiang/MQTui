/**
 * 消息定位续扫的纯逻辑校验。
 *
 * `appendPage` 决定「继续扫描」之后列表长什么样：命中要去重、累计计数要正确、
 * 游标要换成新的。这些规则错一条，界面上的数字就会骗人。
 */

import { expect, test } from "vitest";

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
  expect(result.totalHits).toBe(2);
  expect(result.totalScanned).toBe(100);
  expect(result.pages).toBe(0);
  expect(result.cursor).toBe("c1");
});

test("resumed page accumulates counters and replaces cursor", () => {
  const first = appendPage(undefined, page(["a", "b"], 100, "c1"));
  const second = appendPage(first, page(["c"], 80, "c2"));
  expect(second.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(second.totalHits).toBe(3);
  expect(second.totalScanned).toBe(180);
  expect(second.pages).toBe(1);
  // 游标必须是新的那个，否则「继续」会原地打转。
  expect(second.cursor).toBe("c2");
});

test("duplicates at the page boundary are dropped", () => {
  const first = appendPage(undefined, page(["a", "b"], 100, "c1"));
  const second = appendPage(first, page(["b", "c"], 50, "c2"));
  expect(second.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  // 去重后的新增条数是 1，累计命中不能把重复的那条算两次。
  expect(second.totalHits).toBe(3);
});

test("empty page still advances counters and keeps the scanner honest", () => {
  const first = appendPage(undefined, page(["a"], 100, undefined));
  const second = appendPage(first, page([], 400, "c2"));
  expect(second.totalHits).toBe(1);
  expect(second.totalScanned).toBe(500);
  expect(second.items.length).toBe(1);
});

test("no cursor means the scan reached the end", () => {
  const result = appendPage(undefined, page(["a"], 10, undefined));
  expect(result.cursor).toBe(undefined);
});


// ---- 内容搜索的时间区间 ----

/** 固定一个本地时间点，避开「跑测试时正好跨小时」带来的抖动。 */
function local(iso: string) {
  return parseLocalDateTime(iso) as number;
}

test("formatLocalDateTime never emits utc (no Z, no offset shift)", () => {
  const text = formatLocalDateTime(local("2026-10-26T09:05"));
  expect(text).toBe("2026-10-26T09:05");
  // 回环：格式化再解析必须得到同一个时刻。
  expect(parseLocalDateTime(text)).toBe(local("2026-10-26T09:05"));
});

test("content search fills the missing end of the range", () => {
  const onlyBefore = completeContentRange({
    key: "",
    content: "timeout",
    after: "",
    before: "2026-10-26T10:00",
  });
  // 补出等长窗口（默认一小时），让「错误发生前那一小时」真的是一小时。
  expect(onlyBefore.before).toBe("2026-10-26T10:00");
  expect(onlyBefore.after).toBe("2026-10-26T09:00");

  const onlyAfter = completeContentRange({
    key: "",
    content: "timeout",
    after: "2026-10-26T10:00",
    before: "",
  });
  expect(onlyAfter.after).toBe("2026-10-26T10:00");
  expect(onlyAfter.before).toBe("2026-10-26T11:00");
});

test("complete range and non-content forms are left untouched", () => {
  const complete = { key: "", content: "x", after: "2026-10-26T10:00", before: "2026-10-26T11:00" };
  expect(completeContentRange(complete)).toEqual(complete);

  // 只有 key 的定位不该被塞进一个凭空出现的时间区间。
  const keyOnly = { key: "order-1", content: "", after: "", before: "" };
  expect(completeContentRange(keyOnly)).toEqual(keyOnly);
});

test("build request never sends a half-open content range", () => {
  const request = buildLocateRequest(
    "c1",
    "orders",
    { key: "", content: "timeout", after: "", before: "2026-10-26T10:00" },
    200
  );
  // 两端都在，后端就不可能从日志头开始全量扫。
  expect(request?.after).toBe(local("2026-10-26T09:00"));
  expect(request?.before).toBe(local("2026-10-26T10:00"));
});

test("shifting the range keeps its length and moves both ends", () => {
  const form = {
    key: "",
    content: "timeout",
    after: "2026-10-26T10:00",
    before: "2026-10-26T10:30",
  };
  const earlier = shiftContentRange(form, "earlier");
  expect(earlier.after).toBe("2026-10-26T09:30");
  expect(earlier.before).toBe("2026-10-26T10:00");

  // 往回挪一次再往前挪一次，应当回到原位。
  const back = shiftContentRange(earlier, "later");
  expect(back).toEqual(form);
});

test("shifting an unparsable range changes nothing", () => {
  const form = { key: "", content: "x", after: "", before: "" };
  expect(shiftContentRange(form, "earlier")).toEqual(form);
});

test("buckets only make sense inside a real range", () => {
  // 没有区间就没有「相对位置」，返回空而不是硬切。
  expect(bucketHits([{ timestamp: 100 }], undefined, 1000)).toEqual([]);
  // 倒挂的区间同理。
  expect(bucketHits([{ timestamp: 100 }], 2000, 1000)).toEqual([]);
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
  expect(buckets.length).toBe(3);
  expect(buckets[0].hits).toBe(2);
  expect(buckets[2].hits).toBe(1);
  // 无时间戳的消息不参与统计。
  expect(bucketHits([{ timestamp: undefined }], after, before, 3).reduce((sum, b) => sum + b.hits, 0)).toBe(0);
});

test("scan progress distinguishes exhausted from resumable", () => {
  const done = describeScanProgress({ scanned: 100, hits: 3, pages: 2, exhausted: true });
  expect(done.includes("区间已读完")).toBeTruthy();
  // 没有游标就是读完了，不该再鼓励用户「继续」。
  expect(done.includes("还能继续")).toBe(false);

  const more = describeScanProgress({ scanned: 100, hits: 3, pages: 0, exhausted: false });
  expect(more.includes("还没读完")).toBeTruthy();
});

import { locateFormFromKey, withFallbackKey } from "./message-locate.ts";

test("按 key 继续找只填 key，不继承消息时间戳", () => {
  expect(locateFormFromKey(" order-1 ")).toEqual({
    key: "order-1",
    content: "",
    after: "",
    before: "",
  });
});

test("带进来的 key 覆盖现场 key，但保留用户已经填好的区间", () => {
  const current = { key: "old", content: "timeout", after: "2026-01-01T00:00", before: "2026-01-01T01:00" };
  const next = withFallbackKey(current, "order-9");
  expect(next.key).toBe("order-9");
  expect(next.content).toBe("timeout");
  expect(next.after).toBe("2026-01-01T00:00");
});

test("没有带参数时不动现场表单", () => {
  const current = { key: "kept", content: "", after: "", before: "" };
  expect(withFallbackKey(current, null)).toBe(current);
  expect(withFallbackKey(current, "  ")).toBe(current);
  // 同名不产生新对象，避免无意义的重扫。
  expect(withFallbackKey(current, "kept")).toBe(current);
});
