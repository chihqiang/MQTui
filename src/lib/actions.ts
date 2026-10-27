/**
 * 跨页动作的两件小事：跳到「某个目标的消息」、说清一次破坏性操作会失去什么。
 *
 * 为什么这两件事值得抽出来：
 *
 * 1. **跳消息页的路径**曾经在 7 个页面里各写一遍
 *    （`/connections/${id}/messages?target=${encodeURIComponent(name)}`）。
 *    少一层 `encodeURIComponent` 就带不动带 `/` 或空格的队列名，而错误表现为
 *    「页面打开了，但目标空了」—— 不报错，只是默默不对。
 * 2. **确认框的那句话**决定用户点不点下去。散在页面里时，同一个动作在队列页
 *    与主题页的说法并不一致（一处说「消息会丢」，另一处只说「不可撤销」）。
 *
 * 这里都是纯函数：输入是名字与数字，输出是路径与一句话，vitest 能直接验。
 */

import type { ActionImpact, ActionImpactInput } from "../types/action.ts";

/** 消息页的入口路径。`target` 为空时就是「什么都没选」的消息页。 */
export function messagesPath(connectionId: string | undefined, target?: string): string {
  const base = `/connections/${connectionId ?? ""}/messages`;
  const name = target?.trim();
  if (!name) return base;
  return `${base}?target=${encodeURIComponent(name)}`;
}

/**
 * 一条消息的定位入口。
 *
 * 与 `messagesPath` 分开是因为它多带两件事：`locate=1`（进来就开定位面板）
 * 和可选的 `key`（「按这个 key 继续找」）。分区同理 —— 主题详情的分区行
 * 要能直接翻到「只看 P3」。
 */
export function locatePath(
  connectionId: string | undefined,
  options: { target?: string; key?: string; partition?: number } = {},
): string {
  const params = new URLSearchParams();
  const target = options.target?.trim();
  if (target) params.set("target", target);
  if (options.key) params.set("key", options.key);
  if (options.partition !== undefined) params.set("partition", String(options.partition));
  params.set("locate", "1");
  return `/connections/${connectionId ?? ""}/messages?${params.toString()}`;
}

/** 数字没上报时，文案不能说成「0 条」—— 「不知道」和「没有」是两件事。 */
function amountOf(messages: number | undefined): string {
  if (messages === undefined) return "其中全部消息";
  if (messages <= 0) return "其中没有待消费消息";
  return `其中 ${messages} 条消息`;
}

/**
 * 「清空 / 删除」这类动作的后果。
 *
 * 只在真的会丢消息时把「消息」写在第一句：删一个空队列和删一个有 30 万条
 * 积压的队列，是同一颗按钮、完全不同的决定。
 */
export function describeAction(input: ActionImpactInput): ActionImpact {
  const { target, messages, consumers, losesMessages } = input;
  const consumersText =
    consumers && consumers > 0 ? `，${consumers} 个消费者会立刻断流` : "";

  if (!losesMessages) {
    return {
      summary: `删除 ${target}。队列本身消失，里面的消息不受影响${consumersText}。`,
      irreversible: true,
    };
  }

  return {
    summary: `${target} ${amountOf(messages)}会被永久删除，不可撤销${consumersText}。`,
    irreversible: true,
  };
}

/**
 * 跳转前的那一句提示：多选时「看消息」只能看一个，得说清为什么。
 *
 * 直接把按钮置灰不写原因，用户会以为是权限问题，而不是「一次只能读一个」。
 */
export function singleTargetHint(count: number): string | undefined {
  if (count <= 1) return undefined;
  return `一次只读一个目标：已选 ${count} 个，请先只留一个`;
}
