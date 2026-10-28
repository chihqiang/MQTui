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
  EMPTY_LOCATE_FORM,
  formatLocalDateTime,
  locateFormIssue,
  parseLocalDateTime,
  shiftContentRange,
  type LocateForm,
} from "./message-locate.ts";

/** 定位表单的构造器：新增字段只要在这里给默认值，用例就不必逐个补。 */
function locateForm(patch: Partial<LocateForm> = {}): LocateForm {
  return { ...EMPTY_LOCATE_FORM, ...patch };
}

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

test("没有时间戳的说明不会因为翻页而消失", () => {
  // 遇到无时间戳消息的往往是第一页。后面几页没再遇到时，如果把说明换成本页的
  // `undefined`，用户就再也不知道那批消息去哪了 —— 它们既不在结果里，
  // 也没人告诉他为什么。
  const first = appendPage(undefined, { ...page(["a"], 100, "c1"), undated: "另有 2 条没有时间戳" });
  const second = appendPage(first, page(["b"], 80, "c2"));
  expect(second.undated).toBe("另有 2 条没有时间戳");

  // 新一页自己带了说明时以新的为准（那是这一轮的真实情况）。
  const third = appendPage(second, { ...page(["c"], 60, "c3"), undated: "另有 5 条没有时间戳" });
  expect(third.undated).toBe("另有 5 条没有时间戳");
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
  const onlyBefore = completeContentRange(locateForm({ content: "timeout", before: "2026-10-26T10:00" }));
  // 补出等长窗口（默认一小时），让「错误发生前那一小时」真的是一小时。
  expect(onlyBefore.before).toBe("2026-10-26T10:00");
  expect(onlyBefore.after).toBe("2026-10-26T09:00");

  const onlyAfter = completeContentRange(locateForm({ content: "timeout", after: "2026-10-26T10:00" }));
  expect(onlyAfter.after).toBe("2026-10-26T10:00");
  expect(onlyAfter.before).toBe("2026-10-26T11:00");
});

test("complete range and non-content forms are left untouched", () => {
  const complete = locateForm({ content: "x", after: "2026-10-26T10:00", before: "2026-10-26T11:00" });
  expect(completeContentRange(complete)).toEqual(complete);

  // 只有 key 的定位不该被塞进一个凭空出现的时间区间。
  const keyOnly = locateForm({ key: "order-1" });
  expect(completeContentRange(keyOnly)).toEqual(keyOnly);
});

test("build request never sends a half-open content range", () => {
  const request = buildLocateRequest(
    "c1",
    "orders",
    locateForm({ content: "timeout", before: "2026-10-26T10:00" }),
    200
  );
  // 两端都在，后端就不可能从日志头开始全量扫。
  expect(request?.after).toBe(local("2026-10-26T09:00"));
  expect(request?.before).toBe(local("2026-10-26T10:00"));
});

test("shifting the range keeps its length and moves both ends", () => {
  const form = locateForm({ content: "timeout", after: "2026-10-26T10:00", before: "2026-10-26T10:30" });
  const earlier = shiftContentRange(form, "earlier");
  expect(earlier.after).toBe("2026-10-26T09:30");
  expect(earlier.before).toBe("2026-10-26T10:00");

  // 往回挪一次再往前挪一次，应当回到原位。
  const back = shiftContentRange(earlier, "later");
  expect(back).toEqual(form);
});

test("shifting an unparsable range changes nothing", () => {
  const form = locateForm({ content: "x" });
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
  expect(locateFormFromKey(" order-1 ")).toEqual(locateForm({ key: "order-1" }));
});

test("带进来的 key 覆盖现场 key，但保留用户已经填好的区间", () => {
  const current = locateForm({ key: "old", content: "timeout", after: "2026-01-01T00:00", before: "2026-01-01T01:00" });
  const next = withFallbackKey(current, "order-9");
  expect(next.key).toBe("order-9");
  expect(next.content).toBe("timeout");
  expect(next.after).toBe("2026-01-01T00:00");
});

test("没有带参数时不动现场表单", () => {
  const current = locateForm({ key: "kept" });
  expect(withFallbackKey(current, null)).toBe(current);
  expect(withFallbackKey(current, "  ")).toBe(current);
  // 同名不产生新对象，避免无意义的重扫。
  expect(withFallbackKey(current, "kept")).toBe(current);
});

test("从消费进度找是一个独立的起点，不需要 key 或时间区间", () => {
  const request = buildLocateRequest(
    "c1",
    "orders",
    locateForm({ key: "order-1", fromCommitted: true, group: "orders-worker" }),
    200
  );
  expect(request?.fromCommitted).toBe(true);
  expect(request?.group).toBe("orders-worker");
  expect(request?.after).toBe(undefined);
});

test("勾了消费进度却没选组：拦在本地，不静默退回全量扫描", () => {
  const form = locateForm({ key: "order-1", fromCommitted: true });
  // 后端会从日志开头扫 —— 那就是一次全量扫描，而用户以为自己从位点往后找。
  expect(locateFormIssue(form)).toBe("从消费进度找要先选一个消费组");
  expect(buildLocateRequest("c1", "orders", form, 200)).toBe(null);

  // 只勾了开关、什么都填，同样是「没有条件」。
  expect(buildLocateRequest("c1", "orders", locateForm({ fromCommitted: true }), 200)).toBe(null);
});

test("时间区间优先于消费进度", () => {
  const request = buildLocateRequest(
    "c1",
    "orders",
    locateForm({
      after: "2026-10-26T10:00",
      before: "2026-10-26T11:00",
      fromCommitted: true,
      group: "orders-worker",
    }),
    200
  );
  // 起点仍是用户明确填的区间。字段照样带出去：请求体要说清「我本来想从哪开始」，
  // 而「以谁为准」由后端定，两处各写一份判断早晚会分叉。
  expect(request?.after).toBe(local("2026-10-26T10:00"));
  expect(request?.fromCommitted).toBe(true);
});
