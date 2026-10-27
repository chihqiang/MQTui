/**
 * 消费者连线的展示逻辑。
 *
 * 判断规则在后端 `domain/consumer_link.rs` 里，这里只做前端侧的推导：
 * 队列视角的一行结论、以及页面的总体结论。抽出来是为了能脱离 DOM 单测。
 */

import type { ConsumerHealth, ConsumerLinks, QueueConsumer, QueueConsumption } from "../types/consumer-link.ts";
import type { Tone } from "../types/tone.ts";

/** 单个消费者的健康状态。必须与后端 `judge` 的分支保持一致。 */
export function judgeConsumer(consumer: QueueConsumer): ConsumerHealth {
  if (!consumer.ackRequired) return "healthy";
  if (consumer.prefetchCount === 0) {
    return consumer.messagesUnacknowledged > 0 ? "unboundedPrefetch" : "healthy";
  }
  return consumer.messagesUnacknowledged >= consumer.prefetchCount
    ? "prefetchSaturated"
    : "healthy";
}

/** 队列的消费端结论。一条队列给一个结论，不给模糊的「注意」。 */
export type QueueVerdict =
  /** 有堆积、零消费者：消息进来就再也出不去。 */
  | "unconsumed"
  /** 消费者卡在预取上限，队列只会越堆越多。 */
  | "stalled"
  /** 有消费者但预取无上限，谁先抢到谁吃满。 */
  | "greedy"
  /** 多个消费者共享同一队列，正常。 */
  | "healthy";

export function queueVerdict(item: QueueConsumption): QueueVerdict {
  if (item.consumers.length === 0) {
    return item.messagesReady > 0 ? "unconsumed" : "healthy";
  }
  const healths = item.consumers.map(judgeConsumer);
  if (healths.includes("prefetchSaturated")) return "stalled";
  if (healths.includes("unboundedPrefetch")) return "greedy";
  return "healthy";
}

/** 页面的总体结论：三类问题各自计数。 */
export interface ConsumerOverview {
  unconsumed: number;
  stalled: number;
  greedy: number;
  /** 消费者实际处理过消息（确认数 > 0）的队列数。只看未确认会把卡死的也算成活跃。 */
  activeQueues: number;
}

export function summarizeQueues(items: QueueConsumption[]): ConsumerOverview {
  const overview: ConsumerOverview = { unconsumed: 0, stalled: 0, greedy: 0, activeQueues: 0 };
  for (const item of items) {
    switch (queueVerdict(item)) {
      case "unconsumed":
        overview.unconsumed += 1;
        break;
      case "stalled":
        overview.stalled += 1;
        break;
      case "greedy":
        overview.greedy += 1;
        break;
      default:
        break;
    }
    // 卡在预取上限的消费者未确认数最高，但它恰恰什么都没在处理，不能计入活跃。
    if (queueVerdict(item) === "healthy" && item.messagesUnacknowledged > 0) {
      overview.activeQueues += 1;
    }
  }
  return overview;
}

/**
 * 关键字过滤：队列名 / 连接名 / consumer tag / 账号。
 *
 * 排查时手里通常只有其中一个：可能是队列名，也可能是某台机器的主机名。
 * 不区分大小写——这里搜的是标识符，不是业务 ID。
 */
export function matchQueue(item: QueueConsumption, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;
  if (item.queue.toLowerCase().includes(needle)) return true;
  return item.consumers.some((consumer) =>
    [consumer.connectionName ?? "", consumer.consumerTag, consumer.username, consumer.channel ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/** 页面顶部结论文案。0 的项不出现，但「全都正常」要明说。 */
export function describeOverview(links: ConsumerLinks): string {
  const overview = summarizeQueues(links.queues);
  const parts: string[] = [];
  if (overview.unconsumed > 0) parts.push(`${overview.unconsumed} 个队列有堆积但无人消费`);
  if (overview.stalled > 0) parts.push(`${overview.stalled} 个队列的消费者卡在预取上限`);
  if (overview.greedy > 0) parts.push(`${overview.greedy} 个队列存在无上限预取`);
  if (parts.length === 0) {
    // 「未发现异常：0 个队列的消费端状态正常」是一句自相矛盾的话：压根没队列，
    // 却说状态正常。这类页面在连错 vhost 时很常见，得照实说。
    if (links.queues.length === 0) {
      return "当前 vhost 下没有队列：没有可判断的消费端状态";
    }
    return `未发现异常：${links.queues.length} 个队列的消费端状态正常`;
  }
  return parts.join("；");
}

/**
 * 队列结论的展示信息：文案与色调。
 *
 * 放在 lib 里而不是页面里：命令面板、队列列表、消费者页都要用同一套说法，
 * 三处各写一份迟早会不一致。
 */
export const QUEUE_VERDICT_LABEL: Record<QueueVerdict, string> = {
  unconsumed: "无人消费",
  stalled: "消费卡住",
  greedy: "预取无上限",
  healthy: "正常",
};

export const QUEUE_VERDICT_TONE: Record<QueueVerdict, Tone> = {
  unconsumed: "danger",
  stalled: "danger",
  greedy: "warning",
  healthy: "neutral",
};

export const CONSUMER_HEALTH_LABEL: Record<ConsumerHealth, string> = {
  healthy: "正常",
  unboundedPrefetch: "无上限预取",
  prefetchSaturated: "预取已满",
};

export const CONSUMER_HEALTH_TONE: Record<ConsumerHealth, Tone> = {
  healthy: "success",
  unboundedPrefetch: "warning",
  prefetchSaturated: "danger",
};
