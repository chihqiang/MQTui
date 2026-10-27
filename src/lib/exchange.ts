/**
 * 交换机与绑定的界面逻辑：默认值、唯一键、速率文案。
 *
 * 这些看起来是「一行的格式化」，但它们各自被踩过一次：
 * 绑定唯一键漏掉 `destinationType` 会让「同名队列」与「同名交换机」共用
 * 一个 React key，列表更新时两行互相串内容；速率不收敛 0 则一屏全是
 * `0.00/s`，把「这个交换机没流量」这件真正的信息埋掉。
 */

import type { BindingInfo, BindingSpec, ExchangeInfo, ExchangeSpec } from "../types/topology.ts";

/** 新建交换机的初始值。`durable` 默认开：面板建的通常是业务交换机，重启要还在。 */
export const DEFAULT_EXCHANGE_SPEC: ExchangeSpec = {
  name: "",
  kind: "direct",
  durable: true,
  autoDelete: false,
};

/** 新建绑定的初始值：只认源交换机，目标留空让用户选。 */
export function initialBinding(source: string): BindingSpec {
  return {
    source,
    destination: { name: "", kind: "queue" },
    routingKey: "",
    arguments: [],
  };
}

/**
 * 绑定的唯一键。
 *
 * 同一对 source/destination 可以有多条不同 routing key 的绑定，
 * 所以 routing key 必须进来；destinationType 也必须进来 —— 同名队列与
 * 同名交换机是两种资源。
 */
export function bindingKey(binding: BindingInfo): string {
  return `${binding.source}|${binding.destinationType}|${binding.destination}|${binding.routingKey}`;
}

/** 速率保留两位小数；0 显示为 `-`，避免一屏全是 0。 */
export function formatRate(exchange: ExchangeInfo): string {
  if (!exchange.messageRate) return "-";
  return `${exchange.messageRate.toFixed(2)}/s`;
}

/**
 * 交换机类型的展示文案。
 *
 * 内置四种给中文解释，插件类型（`x-*`）原样显示 —— 我们不认识它，
 * 但也不该把它藏起来：用户得能看出这不是内置类型。
 */
export function exchangeKindLabel(kind: string): string {
  switch (kind) {
    case "direct":
      return "direct（按 routing key 精确匹配）";
    case "topic":
      return "topic（按模式匹配）";
    case "fanout":
      return "fanout（广播到全部绑定）";
    case "headers":
      return "headers（按消息头匹配）";
    default:
      return kind || "未知类型";
  }
}

/**
 * 不可删除的原因；可删除时返回 null。
 *
 * 规则与后端 `ExchangeRemoval` 保持一致：默认交换机、`amq.` 保留命名、
 * 内置交换机一律不给按钮。放在这里而不是页面里，是因为后台里也有一份同样的
 * 判断，两处口径必须能对照着读。
 */
export function removalReason(exchange: ExchangeInfo): string | null {
  if (!exchange.name) return "默认交换机由服务端隐式提供，不可删除";
  if (exchange.name.startsWith("amq.")) return "`amq.` 前缀是 RabbitMQ 保留交换机，不可删除";
  if (exchange.internal) return "内置（internal）交换机不可删除";
  return null;
}

/**
 * 交换机与绑定的过滤。
 *
 * 三条规则一起作用，任一条不写都会让「过滤」变成「筛掉了一半」：
 * - 交换机按名称过滤；
 * - 绑定按「源 / 目标 / routing key」任一处命中保留；
 * - 选中某个交换机时，只留与它相关的绑定（进出都算）。
 */
export function filterTopology(
  data: { exchanges: ExchangeInfo[]; bindings: BindingInfo[] },
  keyword: string,
  selected: string | null,
): { exchanges: ExchangeInfo[]; bindings: BindingInfo[] } {
  const needle = keyword.trim().toLowerCase();
  const match = (value: string) => !needle || value.toLowerCase().includes(needle);
  return {
    exchanges: data.exchanges.filter((item) => match(item.name)),
    bindings: data.bindings.filter(
      (item) =>
        (!selected || item.source === selected || item.destination === selected) &&
        (match(item.source) || match(item.destination) || match(item.routingKey)),
    ),
  };
}
