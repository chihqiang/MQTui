/**
 * 定位结果的拼接规则：「继续扫描」之后列表长什么样。
 *
 * 单独一层是因为这几条规则错了，界面上的数字会骗人：
 * 命中要去重（续扫边界可能重复）、累计扫描要把前面几页加上、
 * 游标必须换成新的（否则点「继续」原地打转）。
 */

import type { MessageSearch } from "../types/message.ts";

/** 累积后的结果。 */
export interface LocatePage extends MessageSearch {
  /** 累积命中条数（含之前若干页）。 */
  totalHits: number;
  /** 累积扫描条数（含之前若干页）。 */
  totalScanned: number;
  /** 已经续扫了几页，0 表示这是第一页。 */
  pages: number;
}

/** 把新一页并入已有结果。 */
export function appendPage(previous: LocatePage | undefined, page: MessageSearch): LocatePage {
  if (!previous) {
    return {
      ...page,
      totalHits: page.items.length,
      totalScanned: page.scanned,
      pages: 0,
    };
  }
  const seen = new Set(previous.items.map((item) => item.id));
  const fresh = page.items.filter((item) => !seen.has(item.id));
  return {
    ...page,
    items: [...previous.items, ...fresh],
    totalHits: previous.totalHits + fresh.length,
    totalScanned: previous.totalScanned + page.scanned,
    pages: previous.pages + 1,
  };
}

/**
 * 时间分组：把命中结果按「区间内的相对位置」切成几段。
 *
 * 为什么需要它：按内容扫一个区间，命中可能只集中在末尾几分钟，
 * 而列表是平铺的倒序——人要自己从第一条翻到最后一条才知道
 * 「这个区间里大部分时间其实是干净的」。分段之后一眼能看出来。
 *
 * 分几段而不是按小时切：区间长度由用户决定，固定步长在不同场景下
 * 一边太碎、一边太粗。段数固定（默认 12），每段的实际时长自动算。
 */
export interface TimeBucket {
  /** 段起点（含），毫秒。 */
  start: number;
  /** 段终点（不含），毫秒。 */
  end: number;
  hits: number;
}

/** 默认的分段数。再多就只是在数格子，看不出趋势。 */
export const DEFAULT_BUCKETS = 12;

/**
 * 按时间区间均分并统计命中。
 *
 * 区间缺失或倒挂时返回空数组：没有区间就没有「相对位置」可言，
 * 硬切出来的分组会误导人。
 */
export function bucketHits(
  items: { timestamp?: number }[],
  after: number | undefined,
  before: number | undefined,
  buckets = DEFAULT_BUCKETS,
): TimeBucket[] {
  if (after === undefined || before === undefined || before <= after || buckets <= 0) {
    return [];
  }
  const span = before - after;
  const step = span / buckets;
  const result: TimeBucket[] = Array.from({ length: buckets }, (_, index) => ({
    start: Math.round(after + step * index),
    end: Math.round(after + step * (index + 1)),
    hits: 0,
  }));

  for (const item of items) {
    if (item.timestamp === undefined) continue;
    // 区间是闭区间，末端的那条消息属于最后一段。
    const index = Math.min(buckets - 1, Math.floor((item.timestamp - after) / step));
    if (index >= 0 && index < buckets) result[index].hits += 1;
  }
  return result;
}

/**
 * 扫描进度的文案口径。
 *
 * 分开返回「扫过什么」和「还剩什么」，是因为按内容扫描时这两件事
 * 由不同的规则决定：前者受单次条数上限约束，后者由游标是否存在决定。
 * 合并成一句「已扫描 N 条」，人会以为再点一次就能扫完。
 */
export function describeScanProgress(options: {
  scanned: number;
  hits: number;
  pages: number;
  exhausted: boolean;
}): string {
  const head = `扫过 ${options.scanned} 条，命中 ${options.hits} 条`;
  const tail = options.exhausted
    ? "区间已读完"
    : options.pages > 0
      ? `已续扫 ${options.pages} 次，还能继续`
      : "区间还没读完，可以继续扫描";
  return `${head} · ${tail}`;
}
