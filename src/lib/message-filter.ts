/**
 * 消息过滤：纯函数，本地过滤已加载的消息，不发请求。
 *
 * 为什么放在前端而不是后端：Kafka 没有「按内容查消息」的索引，真做服务端
 * 搜索得把整段日志扫一遍；RabbitMQ 更是只能逐条 basic_get。排查时更常见的
 * 用法是「先看一眼最近的消息，再从中挑出关心的那条」，本地过滤够用且即时。
 */

import type { MessageSummary } from "../types/message.ts";

/** 过滤条件。空串表示不限制该维度。 */
export interface MessageFilter {
  /** 按消息 key 过滤，区分大小写（key 通常是业务 ID）。 */
  key: string;
  /** 按内容片段过滤，不区分大小写（随手输入的词不该纠结大小写）。 */
  content: string;
}

export const EMPTY_FILTER: MessageFilter = { key: "", content: "" };

/** 是否设置了任何过滤条件。 */
export function isFilterActive(filter: MessageFilter): boolean {
  return filter.key.trim() !== "" || filter.content.trim() !== "";
}

/**
 * 判断单条消息是否命中过滤条件。
 *
 * key 缺失的消息在按 key 过滤时一律排除：用户明确在找某个 key，
 * 把「没有 key」的消息混进来只会增加噪音。
 */
export function matchesFilter(message: MessageSummary, filter: MessageFilter): boolean {
  const key = filter.key.trim();
  if (key && !message.key?.includes(key)) return false;

  const content = filter.content.trim().toLowerCase();
  if (content && !message.preview.toLowerCase().includes(content)) return false;

  return true;
}

/** 批量过滤。列表可能上万条，先在调用方做 memo，这里只保持 O(n)。 */
export function filterMessages(
  messages: MessageSummary[],
  filter: MessageFilter,
): MessageSummary[] {
  if (!isFilterActive(filter)) return messages;
  return messages.filter((message) => matchesFilter(message, filter));
}
