/**
 * 主题吞吐的判读：纯函数，不发请求。
 *
 * 后端已经算好了数字，这里只负责「这个数字该怎么读」：
 * 窗口不可用时要明说、速率太小别显示成 0、分区速率排序后的第一名才是热点。
 * 判定口径与 `src-tauri/src/domain/topic_throughput.rs` 保持一致，改一边记得改另一边。
 */

import type { SampleWindow, TopicThroughput } from "../types/topic-throughput.ts";

/** 速率文案：每秒不足一条时说清楚，而不是显示 `0.00/s`。 */
export function formatThroughput(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "静止";
  if (rate < 0.01) return "< 0.01 条/秒";
  if (rate < 1) return `${rate.toFixed(2)} 条/秒`;
  if (rate < 10) return `${rate.toFixed(1)} 条/秒`;
  return `${Math.round(rate).toLocaleString("zh-CN")} 条/秒`;
}

/** 窗口不可用时的那句提示；可用则返回 `undefined`。 */
export function windowWarning(window: SampleWindow): string | undefined {
  switch (window) {
    case "fresh":
      return undefined;
    case "tooShort":
      return "两次采样挨得太近，速率跳动较大，多采几次再看";
    case "tooOld":
      return "样本已超过 30 分钟，显示的是那段时间的平均速率";
    case "invalid":
      return "两次采样的时间顺序不对，本次不计算速率";
  }
}

/** 速率能不能当真。窗口不可用时界面要把数字压暗并标注。 */
export function rateIsTrustworthy(window: SampleWindow): boolean {
  return window === "fresh";
}

/** 本次检查是否有分区完全不增长：写侧已经停了，但消息还堆着。 */
export function isIdle(report: TopicThroughput): boolean {
  return report.delta === 0 && report.window === "fresh";
}

/**
 * 一句话结论，放在卡片标题旁边。
 *
 * 只做「读数字」这件事：`有写入但很慢`、`完全静止` 这类判断不该让用户
 * 自己去比 `delta` 与分区数。
 */
export function summarize(report: TopicThroughput): string {
  if (!rateIsTrustworthy(report.window)) {
    const warning = windowWarning(report.window);
    return warning ?? "本次采样不可用";
  }
  if (report.delta === 0) {
    return "窗口内没有新消息写入";
  }
  return `窗口内写入 ${report.delta.toLocaleString("zh-CN")} 条 · ${formatThroughput(report.rate)}`;
}

/** 窗口时长文案：`5.0 秒`。 */
export function formatWindow(windowMs: number): string {
  const seconds = windowMs / 1000;
  return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}

/** 增长最多的那个分区；全都不增长时为 `undefined`。 */
export function busiest(report: TopicThroughput): { partition: number; rate: number } | undefined {
  const top = report.partitions[0];
  return top ? { partition: top.partition, rate: top.rate } : undefined;
}
