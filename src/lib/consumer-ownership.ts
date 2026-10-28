/**
 * 消费者归属的判读：纯函数，不发请求。
 *
 * 判定口径与 `src-tauri/src/domain/consumer_ownership.rs` 保持一致，
 * 改一边记得改另一边。
 */

import type { ConsumerOwner, OwnershipSnapshot, QueueOwnership } from "../types/consumer-ownership.ts";

/** 展示用的连接名：客户端上报的名字优先，其次服务端生成的，最后给一句话。 */
export function connectionLabel(owner: ConsumerOwner): string {
  return owner.clientName || owner.connection || "未知连接";
}

/** 这个消费者该不该被标出来。 */
export function isUnhealthy(owner: ConsumerOwner): boolean {
  return owner.health !== "healthy" || owner.connectionBlocked;
}

/** 有堆积却一个消费者都没有：消息进来就再也不会出去。 */
export function isUnconsumed(queue: QueueOwnership): boolean {
  return queue.owners.length === 0 && queue.messagesReady > 0;
}

/**
 * 这条队列被一条连接独占吗。
 *
 * 单连接独占不一定有问题，但扩容时最想知道的就是「这个数字为什么一直是 1」。
 */
export function isSingleConnection(queue: QueueOwnership): boolean {
  return queue.connections === 1 && queue.owners.length > 0;
}

/** 一句话结论，写在卡片标题上。 */
export function queueVerdict(queue: QueueOwnership): string {
  if (queue.owners.length === 0) {
    return queue.messagesReady > 0
      ? `没人消费，堆着 ${queue.messagesReady} 条`
      : "没人消费（队列是空的）";
  }
  const parts = [`${queue.owners.length} 个消费者 / ${queue.connections} 条连接`];
  if (isSingleConnection(queue)) parts.push("单连接独占");
  if (queue.troubled > 0) parts.push(`${queue.troubled} 个有异常`);
  return parts.join(" · ");
}

/**
 * 快照的一句话结论。
 *
 * 一个消费者都没有时，「几个队列堆着消息」比「没有任何消费者」有用得多 ——
 * 后者听起来像「这集群是空的」。
 */
export function ownershipVerdict(snapshot: OwnershipSnapshot): string {
  const consumers = snapshot.queues.reduce((sum, item) => sum + item.owners.length, 0);
  if (consumers === 0) {
    const waiting = snapshot.queues.filter(isUnconsumed).length;
    return waiting > 0
      ? `没有任何消费者：${waiting} 个队列堆着消息没人消费`
      : "没有任何消费者";
  }
  const connections = new Set(
    snapshot.queues.flatMap((item) => item.owners.map(connectionLabel)),
  ).size;
  const unconsumed = snapshot.queues.filter(isUnconsumed).length;
  let text = `${consumers} 个消费者 / ${connections} 条连接 / ${snapshot.users.length} 个账号`;
  if (unconsumed > 0) text += `，${unconsumed} 个队列有堆积却没人消费`;
  if (snapshot.blockedConsumers > 0) text += `，${snapshot.blockedConsumers} 个消费者的连接已阻塞`;
  return text;
}

/** 单连接独占的队列。 */
export function singleConnectionQueues(snapshot: OwnershipSnapshot): QueueOwnership[] {
  return snapshot.queues.filter(isSingleConnection);
}

/**
 * 按关键词过滤。
 *
 * 搜索范围刻意包含对端地址与账号：排查「哪个 pod 在消费」时，能搜的往往
 * 只有一个 IP 或一个用户名，而队列名早就知道了。
 */
export function matchQueue(queue: QueueOwnership, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  if (queue.queue.toLowerCase().includes(needle)) return true;
  return queue.owners.some((owner) =>
    [
      connectionLabel(owner),
      owner.peer ?? "",
      owner.username,
      owner.consumerTag,
      owner.channel ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/** 只看有问题的队列。 */
export function onlyTroubled(queues: QueueOwnership[]): QueueOwnership[] {
  return queues.filter(
    (queue) =>
      isUnconsumed(queue) ||
      queue.troubled > 0 ||
      queue.owners.some((owner) => owner.connectionBlocked),
  );
}
