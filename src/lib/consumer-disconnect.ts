/**
 * 断开消费者的前端判定，与后端 `domain/consumer_disconnect.rs` 一一对应。
 *
 * 为什么两边各写一份：前端需要在**渲染阶段**就知道按钮该不该亮、hover 上该写什么，
 * 为这个问题去发一次请求不值当。但判定结果必须与后端一致——所以这里的规则
 * 保持极简（三条 if），并由 `consumer-disconnect.test.mts` 逐条对照后端用例。
 *
 * 真正生效的仍然是后端：前端这份只决定界面，后端会按当时的实时快照再复核一次
 * （快照可能已经过期，消费者也许刚好领了一批消息开始干活）。
 */

import type { DisconnectVerdict, QueueConsumer } from "@/types";

/** 面板自己创建的消费者 tag 前缀，与后端 `PANEL_TAG_PREFIX` 一致。 */
export const PANEL_TAG_PREFIX = "mqtui";

/** 判定结果与文案。`allowed` 也有提示——允许不等于安全。 */
export const DISCONNECT_VERDICT_NOTE: Record<DisconnectVerdict, string> = {
  allowed: "断开后对端服务会立刻失去该消费者，未确认消息会回到队列并可能被重复投递",
  unknownTarget: "消费者标签不合法，无法定位到具体目标",
  ownedByPanel: "这是面板自己的临时消费者，不应手动断开",
  inFlight: "该消费者还有未确认消息在手上，断开会导致消息回队并被重复消费",
};

/** 判断一个消费者能否被断开。 */
export function evaluateDisconnect(consumer: QueueConsumer): DisconnectVerdict {
  const tag = consumer.consumerTag.trim();
  // 空 tag、含 `/` 或控制字符：管理 API 的路径里塞不进去，也定位不到。
  // eslint-disable-next-line no-control-regex
  if (!tag || tag.includes("/") || /[\u0000-\u001f\u007f]/.test(tag)) {
    return "unknownTarget";
  }
  if (tag.startsWith(PANEL_TAG_PREFIX)) return "ownedByPanel";
  // 有未确认消息说明它正在干活：断开等于强行打断一次业务处理。
  if (consumer.messagesUnacknowledged > 0) return "inFlight";
  return "allowed";
}

/** 确认串是否与队列名一致（后端同样要求，这里先给即时反馈）。 */
export function confirmMatches(queue: string, confirm: string): boolean {
  const expected = queue.trim();
  return expected !== "" && confirm.trim() === expected;
}
