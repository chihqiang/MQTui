/**
 * 消息定位条件的纯逻辑：表单输入 → 后端查询参数。
 *
 * 为什么单独一层：定位是一次**顺序扫描**，条件含糊的代价很高
 * （扫几十万条只为找一条），所以「什么都没填就别发请求」这类规则
 * 必须先在前端判断清楚，而不是把空条件丢给后端跑一遍。
 */

import type { MessageLocate } from "@/types";

/** 定位表单的原始输入（全部是字符串，直接对应输入框的值）。 */
export interface LocateForm {
  key: string;
  /** 消息内容片段，包含匹配、不区分大小写。 */
  content: string;
  /** `datetime-local` 的值，形如 `2026-10-26T10:00`。 */
  after: string;
  before: string;
}

export const EMPTY_LOCATE_FORM: LocateForm = {
  key: "",
  content: "",
  after: "",
  before: "",
};

/** 表单是否为空：空表单不该触发扫描。 */
export function isLocateFormEmpty(form: LocateForm): boolean {
  return (
    form.key.trim() === "" &&
    form.content.trim() === "" &&
    form.after.trim() === "" &&
    form.before.trim() === ""
  );
}

/**
 * `datetime-local` 需要的本地时间格式：`2026-10-26T10:00`。
 *
 * 不能用 `toISOString()`——那是 UTC，直接塞进 `datetime-local` 会差一个时区。
 * 单独写而不是用 `toLocaleString()`：后者格式随浏览器语言变化，塞不进输入框。
 */
export function formatLocalDateTime(millis: number): string {
  const date = new Date(millis);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join("T");
}

/** 首屏建议的区间跨度：按内容扫描的代价，一小时通常够了。 */
export const CONTENT_DEFAULT_SPAN_MS = 60 * 60 * 1000;

/** 一步「往前挪」的跨度：上一次扫完了还想往更早看，多半是同一个量级。 */
export const CONTENT_STEP_MS = 60 * 60 * 1000;

/** 内容定位按时间区间推进一步的方向。 */
export type ContentStep = "earlier" | "later";

/**
 * 只给了一端时间时，把区间补齐。
 *
 * 只给 `before`（「错误发生前那一小时」是最常见的排查说法）而不给 `after`，
 * 后端会从分区末尾往前扫——扫的是整个日志，不是这一小时。补一个等长窗口，
 * 让「区间」真的成立。
 */
export function completeContentRange(form: LocateForm): LocateForm {
  if (form.content.trim() === "") return form;
  const after = form.after.trim();
  const before = form.before.trim();
  if (!before) {
    // 「从 10:00 往后看」是明确的意图：窗口的终点就是起点 + 一步，
    // 不要自作主张改成「从 10:00 到现在」——那是另一段区间。
    const start = parseLocalDateTime(after);
    if (start === undefined) return form;
    return { ...form, before: formatLocalDateTime(start + CONTENT_DEFAULT_SPAN_MS) };
  }
  if (!after) {
    const end = parseLocalDateTime(before);
    if (end === undefined) return form;
    return { ...form, after: formatLocalDateTime(end - CONTENT_DEFAULT_SPAN_MS) };
  }
  return form;
}

/**
 * 把时间区间整体挪一步。
 *
 * 为什么需要它：内容扫描单次最多 5000 条，靠「继续扫描」往下翻是对的；
 * 但翻到底之后想看得更早，只能改区间。让人手打两个时间戳，等于每次让
 * 他自己算一遍往哪挪——这里按当前区间长度平移，方向明确。
 *
 * 任一端解析失败时原样返回：宁可不挪，也不要把用户填的东西弄没了。
 */
export function shiftContentRange(form: LocateForm, step: ContentStep): LocateForm {
  const after = parseLocalDateTime(form.after);
  if (after === undefined) return form;
  const before = parseLocalDateTime(form.before) ?? after + CONTENT_STEP_MS;
  // 区间倒挂时按「起点 + 一步」兜底，避免算出负跨度。
  const span = before > after ? before - after : CONTENT_STEP_MS;
  const delta = step === "earlier" ? -span : span;
  return {
    ...form,
    after: formatLocalDateTime(after + delta),
    before: formatLocalDateTime(before + delta),
  };
}

/**
 * 内容定位的准入检查。
 *
 * 内容匹配要把每条 payload 完整解出来再比对，没有时间区间就退化成全量扫日志。
 * 后端也会拒绝（`locate::content_scan_issue`），这里先拦一次是为了让用户
 * 在点按钮之前就看到为什么不行，而不是点完等一个错误。
 */
export function contentScanIssue(form: LocateForm): string | null {
  if (form.content.trim() === "") return null;
  if (form.after.trim() === "" && form.before.trim() === "") {
    return "按内容查找必须同时给出时间区间：内容匹配要逐条解码消息体，没有区间等于扫全量日志";
  }
  return null;
}

/**
 * `datetime-local` 的本地时间转毫秒时间戳。
 *
 * `datetime-local` 不带时区，用户填的是「自己表上的时间」，
 * 所以直接用 `new Date(value)` 按本地时区解释——不要加 `Z`，
 * 否则用户在东八区填 10:00 会被当成 UTC 10:00，差 8 小时。
 */
export function parseLocalDateTime(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const millis = new Date(trimmed).getTime();
  return Number.isNaN(millis) ? undefined : millis;
}

/**
 * 组装查询条件。
 *
 * 返回 `null` 表示表单不完整或非法，调用方应提示用户而不是发请求。
 * 空 key 不下发：后端把空串当「不按 key 过滤」，但这里干脆不发，
 * 让请求体本身就能说明条件是什么。
 */
export function buildLocateRequest(
  connectionId: string,
  target: string,
  form: LocateForm,
  limit: number,
): MessageLocate | null {
  const key = form.key.trim();
  const after = parseLocalDateTime(form.after);
  const before = parseLocalDateTime(form.before);

  const content = form.content.trim();

  if (form.after.trim() && after === undefined) return null;
  if (form.before.trim() && before === undefined) return null;
  if (after !== undefined && before !== undefined && after > before) return null;
  if (contentScanIssue(form)) return null;
  if (!key && !content && after === undefined && before === undefined) return null;

  // 只给一端时间的内容搜索会退化成「扫全量」：补一个等长窗口，
  // 让下发的请求里两端都在，后端就不可能从日志头或末尾开始扫。
  if (content && (after === undefined || before === undefined)) {
    const completed = completeContentRange(form);
    // 补齐失败（例如 before 填了但解析不出时间）就当作表单不合格，
    // 绝不带着「只有一端」的区间发请求——那是全量扫日志的入口。
    if (completed.after.trim() === "" || completed.before.trim() === "") return null;
    return buildLocateRequest(connectionId, target, completed, limit);
  }

  return {
    connectionId,
    target,
    key: key || undefined,
    content: content || undefined,
    after,
    before,
    limit,
  };
}

/** 条件指纹，用作 React Query 的 key 片段。相同条件复用缓存，不重复扫日志。 */
export function locateConditionKey(request: MessageLocate | null): string {
  if (!request) return "none";
  return [
    request.key ?? "",
    request.content ?? "",
    request.after ?? "",
    request.before ?? "",
    request.limit ?? "",
  ].join("|");
}

/**
 * 表单不合格的原因，用于提示文案。
 *
 * 分开返回而不是一个 boolean：用户需要知道是「时间填错了」还是「什么都没填」。
 */
export function locateFormIssue(form: LocateForm): string | null {
  const after = parseLocalDateTime(form.after);
  const before = parseLocalDateTime(form.before);
  if (form.after.trim() && after === undefined) return "起始时间格式不正确";
  if (form.before.trim() && before === undefined) return "结束时间格式不正确";
  if (after !== undefined && before !== undefined && after > before) {
    return "起始时间晚于结束时间";
  }
  const contentIssue = contentScanIssue(form);
  if (contentIssue) return contentIssue;
  if (isLocateFormEmpty(form)) return "至少填写 key、内容片段或时间区间之一";
  return null;
}

/**
 * 从一条已经看到的消息生成定位表单：「按这个 key 继续找」。
 *
 * 为什么要绕回定位面板而不是就地加一个「同 key 的下一条」：定位是**顺序扫描**，
 * 有区间、有游标、有代价说明。就地翻页会把这三件事藏起来，用户翻着翻着就不知道
 * 自己兜了多大一圈。把人带回定位面板、把 key 填进去，代价与范围依旧是可见的。
 *
 * 时间区间不继承消息时间戳：一条消息的时间只是区间里的一个点，拿它当区间会
 * 立刻空手而归。留空即「从头顺序扫」，那是这个动作最常见的意图。
 */
export function locateFormFromKey(key: string): LocateForm {
  return { ...EMPTY_LOCATE_FORM, key: key.trim() };
}

/**
 * 带参数的定位表单与「用户已经动过的表单」的合并规则。
 *
 * 规则只有一条：**刚带进来的参数优先，其余字段沿用现场**。比如用户手上正开着
 * 一个时间区间，从详情里点了「按这个 key 继续找」，他期待的是「在这个区间里
 * 按这个 key 找」，而不是把区间清掉。
 *
 * 参数为空（没带）时原样返回，避免把一个干净的表单洗成空表单而触发多余的重扫。
 */
export function withFallbackKey(current: LocateForm, key: string | null): LocateForm {
  const incoming = key?.trim();
  if (!incoming || current.key.trim() === incoming) return current;
  return { ...current, key: incoming };
}
