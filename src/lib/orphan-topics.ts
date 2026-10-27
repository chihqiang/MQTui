/**
 * 孤儿主题页的纯逻辑：范围摘要、堆积量的三档阈值。
 */

import type { OrphanScanScope } from "../types/orphan.ts";

/**
 * 扫描范围的一句话摘要。
 *
 * 放在卡片右上角而不是标题里：用户改了范围往往忘了自己选的是什么，
 * 而「全量扫描」与「前缀 order.」的结果数量级完全不同。
 */
export function describeScope(scope: OrphanScanScope): string {
  const topics = scope.topics ?? [];
  const trimmed = scope.prefix?.trim() ?? "";
  if (topics.length && trimmed) return `${topics.length} 个主题 + 前缀 ${trimmed}`;
  if (topics.length) return `${topics.length} 个指定主题`;
  if (trimmed) return `前缀 ${trimmed}`;
  return "全量扫描";
}

/**
 * 未被消费的消息量对应的色调。
 *
 * 阈值比消费组页的滞后更严（1 千就转警示）：这里统计的是「没有任何组认领」
 * 的消息，它们不会自己消失，只会一直堆到磁盘满。
 */
export function orphanTone(messages: number): "danger" | "warning" | "neutral" {
  if (messages >= 10_000) return "danger";
  if (messages >= 1_000) return "warning";
  return "neutral";
}
