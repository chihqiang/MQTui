/**
 * RabbitMQ 运行时页的展示逻辑。
 *
 * 与后端 `domain/runtime.rs` 的分工：后端判定「预取是否打满」「队列有没有位置」，
 * 这里只决定这些结论怎么呈现。抽成纯函数是为了能脱 DOM 单测：
 * 页面里最容易出错的地方恰恰是「哪些行该被标红」。
 */

import type { ChannelRow, ConnectionDetail, ConnectionRow, RuntimeSnapshot } from "@/types";
import type { Tone } from "@/types/tone";

/** 连接的展示色调。阻塞中的连接必须显眼：发布方看起来「发出去了但没反应」。 */
export function connectionTone(row: ConnectionRow): Tone {
  if (row.state === "blocking" || row.state === "blocked") return "danger";
  return row.state === "running" ? "success" : "warning";
}

/** 通道是否预取打满。与后端 `ChannelRow::is_saturated` 口径一致。 */
export function channelSaturated(channel: ChannelRow): boolean {
  return channel.prefetch > 0 && channel.unacked >= channel.prefetch;
}

/** 通道是否空转：开着、没有消费者、也没确认过任何消息。 */
export function channelIdle(channel: ChannelRow): boolean {
  return channel.consumers === 0 && channel.acks === 0 && channel.unacked === 0;
}

/**
 * 通道的展示色调。
 *
 * 打满的红、空转的黄、其余中性——空转的通道是个温和的提醒（可能是忘了关），
 * 但它不会造成数据问题，所以不用红色。
 */
export function channelTone(channel: ChannelRow): Tone {
  if (channelSaturated(channel)) return "danger";
  if (channelIdle(channel)) return "warning";
  return "neutral";
}

/** 页面顶部的一句话总结。 */
export function describeRuntime(snapshot: RuntimeSnapshot): string {
  const stuck = snapshot.connections.filter(
    (detail) => detail.saturated > 0 || detail.connection.state === "blocking",
  ).length;
  const parts = [
    `${snapshot.connections.length} 条连接`,
    `${snapshot.connections.reduce((sum, item) => sum + item.channels.length, 0)} 个通道`,
    `${snapshot.queues.length} 个队列`,
  ];
  const head = parts.join(" · ");
  if (stuck > 0) return `${head}；${stuck} 条连接有卡住的通道`;
  if (snapshot.unassigned.length > 0) {
    return `${head}；${snapshot.unassigned.length} 个队列没有可用节点`;
  }
  return head;
}

/** 关键字过滤：连接名、客户端名、账号、对端地址都能搜。 */
export function matchConnection(detail: ConnectionDetail, keyword: string): boolean {
  const term = keyword.trim().toLowerCase();
  if (!term) return true;
  const { connection } = detail;
  return [connection.name, connection.clientName, connection.user, connection.peerHost]
    .join(" ")
    .toLowerCase()
    .includes(term);
}

/** 该连接的通道里有没有需要看的东西。 */
export function connectionHasProblem(detail: ConnectionDetail): boolean {
  return (
    detail.saturated > 0 ||
    detail.connection.state === "blocking" ||
    detail.connection.state === "blocked" ||
    detail.channels.some((channel) => channelSaturated(channel) || channelIdle(channel))
  );
}
