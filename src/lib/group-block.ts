/**
 * 队头阻塞结论的排版：纯函数，不发请求。
 *
 * 后端给的是「谁卡住了 + 为什么这么判」，这里只把这些变成界面上的一句话与配色。
 * 三种状态必须分开说，混成一句话就等于什么都没说：
 * - `idle`：整组没动 —— 可能没流量，也可能全挂了，处置方式完全不同；
 * - `blocked`：有人动、有人不动 —— 这才是队头阻塞；
 * - 都不是：健康。
 */

import type { BlockReport, StuckPartition } from "../types/group-block.ts";
import type { Tone } from "../types/tone.ts";

/**
 * 结论的语气。
 *
 * 只有「确认阻塞」才用危险色：`idle` 是一个观察不到的现象，
 * 不是故障 —— 半夜没人写数据时滞后本来就不变，标红会让人白白排查一轮。
 */
export function verdictTone(report: BlockReport): Tone {
  if (report.blocked) return "danger";
  if (report.idle) return "warning";
  return "success";
}

/** 标题旁的一句话。 */
export function headline(report: BlockReport): string {
  if (report.blocked) {
    const total = report.stuck.reduce((sum, item) => sum + item.lag, 0);
    return `队头阻塞 · ${report.stuck.length} 个分区 · 积压 ${total.toLocaleString("zh-CN")} 条`;
  }
  if (report.idle) return "整组未推进";
  return report.headline;
}

/** 卡住分区的标识，`topic-分区号`。 */
export function stuckLabel(item: StuckPartition): string {
  return `${item.topic}-${item.partition}`;
}

/**
 * 归属成员的文案。
 *
 * 拿不到归属时写「未知」而不是留空：留空会让人以为这个分区没有分配者，
 * 而实际上只是这一层查不到。
 */
export function memberText(item: StuckPartition): string {
  const members = item.members ?? [];
  return members.length ? members.join("、") : "未知";
}

/**
 * 卡住分区的处置建议。
 *
 * 只给「下一步做什么」，不说「可能是什么原因」—— 面板看不到用户的业务代码，
 * 编一个原因会让人往错的方向查。
 */
export function advice(report: BlockReport): string | undefined {
  if (report.blocked) {
    return "先看卡住分区里那条最早的消息（按位点定位），确认是不是处理不完的毒消息；临时办法是跳过这一条或重置该分区位点";
  }
  if (report.idle && report.stuck.length > 0) {
    return "窗口内没有任何分区推进：先确认上游还在写、成员还在拉取，再考虑是不是全部成员都卡住了";
  }
  return undefined;
}

/** 位点回退的分区清单文案；没有回退时返回 `undefined`。 */
export function regressedText(report: BlockReport): string | undefined {
  if (!report.regressed.length) return undefined;
  return `${report.regressed.join("、")} 的位点在窗口内回退（重置或被截断），不参与判定`;
}
