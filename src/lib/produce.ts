/**
 * 发送消息的纯逻辑。
 *
 * 这一层的存在理由是「Kafka 和 RabbitMQ 的发送参数根本不是一套」：
 * topic + key 与 exchange + routing key + 投递模式 + headers 是两种协议的概念，
 * 合成一张表单就得靠 `disabled` 和「这一格仅 xxx 有效」的提示互相打补丁。
 * 所以表单按中间件分开，判断与组装都放在这里，让页面只画字段。
 */

import type { MessageHeader } from "@/types";

/** 投递模式：broker 只认这两个值，其余数字会被 lapin 悄悄忽略。 */
export const DELIVERY_MODES = [
  { value: 1, label: "非持久化", hint: "broker 重启后不保证还在" },
  { value: 2, label: "持久化", hint: "需要队列本身也是持久的" },
] as const;

export type DeliveryMode = (typeof DELIVERY_MODES)[number]["value"];

/** 默认非持久化：发一条验证消息却让它写进磁盘，是把调试成本转给磁盘。 */
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 1;

/** 表单里的一行 header。key 为空的行按「没填」处理，不算错误。 */
export interface HeaderRow {
  key: string;
  value: string;
}

/**
 * 把表单行收成请求里的 headers。
 *
 * 空 key 直接丢掉而不是报错：用户点了「加一行」又改主意，是很正常的事。
 * 值允许为空串 —— AMQP 里「有这个 header，值为空」和「没有这个 header」是两回事。
 */
export function toHeaders(rows: readonly HeaderRow[]): MessageHeader[] {
  return rows
    .filter((row) => row.key.trim() !== "")
    .map((row) => ({ key: row.key.trim(), value: row.value }));
}

/**
 * Kafka 的 key 要不要发。
 *
 * 空串不能直接送出去：`Some("")` 会被 broker 当成一个空 key 参与分区哈希，
 * 于是所有「没填 key」的消息全落到同一个分区 —— 看起来像写错了轮询配置。
 * 所以空 key 必须降级成 `undefined`。
 */
export function kafkaKey(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

/**
 * 常见内容类型。
 *
 * `hint` 写「下游会怎么理解它」，因为这一格真正的风险不是填错格式，
 * 而是填了一个下游不认的格式 —— AMQP 不会拒收，只是把它当成别的东西。
 */
export const CONTENT_TYPES = [
  { value: "application/json", hint: "JSON 消费者按这条走；发对象就选它" },
  { value: "text/plain", hint: "默认值，任何消费者都能读" },
  { value: "application/xml", hint: "XML 消费者" },
  { value: "application/octet-stream", hint: "二进制；内容会被当字节流" },
] as const;

/** 没填这一格时后端用的值，与 `domain::message::DEFAULT_CONTENT_TYPE` 一致。 */
export const DEFAULT_CONTENT_TYPE = "text/plain";

/**
 * 内容类型 / 编码能不能交给 broker。
 *
 * 两者都是 AMQP 的 shortstr（≤255 字节），超了会在 publish 阶段出问题 ——
 * 那时消息已经组装好，报错里看不到自己填的是什么。空串按「没填」处理：
 * 表单清空格子产生的空串不是错误。
 */
export function contentFieldProblem(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // eslint-disable-next-line no-control-regex
  if (/\s/.test(trimmed)) return `${label}里不能有空格`;
  // 用 UTF-8 字节数，不是字符数 —— AMQP 限的是字节。
  if (new TextEncoder().encode(trimmed).length > 255) return `${label}最长 255 字节`;
  return null;
}

/** 空串等于「没填」，交给后端走默认值，而不是发一个空内容类型过去。 */
export function contentField(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** exchange 空串就是默认交换机，不要 trim 成需要额外处理的形态。 */
export function exchangeName(value: string): string {
  return value.trim();
}

/**
 * 判定「这条消息发得出去吗」，返回第一处问题的人话说明。
 *
 * 分成逐项检查而不是一个布尔值：表单里有四五个必填格，
 * 只说「还差点东西」等于让用户自己逐个试。
 */
export function sendBlockers(input: {
  kind: "kafka" | "rabbitMq";
  topic?: string;
  exchange?: string;
  routingKey?: string;
  contentType?: string;
  contentEncoding?: string;
  payload: string;
}): string | null {
  if (input.payload === "") return "消息内容不能为空";
  if (input.kind === "kafka") {
    if ((input.topic ?? "").trim() === "") return "先选一个 topic";
    return null;
  }
  // routing key 可以空（默认交换机下按队列名直投要填，但绑定可以带空 key），
  // 所以这里只拦「exchange 和 routing key 都没填」这种一定发不到任何地方的组合。
  if ((input.exchange ?? "").trim() === "" && (input.routingKey ?? "").trim() === "") {
    return "默认交换机需要 routing key（通常就是队列名）";
  }
  return (
    contentFieldProblem("内容类型", input.contentType ?? "") ??
    contentFieldProblem("内容编码", input.contentEncoding ?? "")
  );
}
