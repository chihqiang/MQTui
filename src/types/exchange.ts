/** 交换机类型的展示信息（名称来自 `domain/exchange.rs` 的 `ExchangeKind`）。 */

export interface ExchangeKindOption {
  value: string;
  label: string;
  hint: string;
}

/**
 * 新建交换机时可选类型的顺序与说明。
 *
 * 顺序按「建一个交换机时会先想到哪种」排：业务上 90% 是 `direct` / `topic`，
 * `headers` 和 `x-*` 是排查或特殊场景才用。
 */
export const EXCHANGE_KIND_OPTIONS: readonly ExchangeKindOption[] = [
  { value: "direct", label: "direct", hint: "routing key 完全匹配，最常用" },
  { value: "topic", label: "topic", hint: "按 `*` / `#` 通配匹配，一个交换机顶一类业务" },
  { value: "fanout", label: "fanout", hint: "忽略 routing key，广播给所有绑定队列" },
  { value: "headers", label: "headers", hint: "按消息头匹配，routing key 不参与" },
  { value: "x-consistent-hash", label: "x-consistent-hash", hint: "插件提供：按 routing key 哈希分配" },
  { value: "x-modulus-hash", label: "x-modulus-hash", hint: "插件提供：取模哈希，扩容时会重分布" },
];

/** 交换机类型的色调：`headers` 与插件类型更容易配错，用提示色而不是中性色。 */
export const EXCHANGE_KIND_TONE: Record<string, "info" | "accent" | "neutral"> = {
  direct: "info",
  topic: "info",
  fanout: "info",
  headers: "accent",
  "x-consistent-hash": "accent",
  "x-modulus-hash": "accent",
};

/** 交换机表的列。列是「一页数据长什么样」的约定，不放页面里。 */
export const EXCHANGE_COLUMNS = [
  { key: "name", label: "名称" },
  { key: "type", label: "类型", width: "w-24" },
  { key: "vhost", label: "vhost", width: "w-28" },
  { key: "rate", label: "入站速率", width: "w-24", align: "right" },
  { key: "actions", label: "操作", width: "w-32", align: "right" },
] as const;

/** 绑定表的列。 */
export const BINDING_COLUMNS = [
  { key: "source", label: "源交换机" },
  { key: "routingKey", label: "routing key" },
  { key: "destination", label: "目标" },
  { key: "actions", label: "操作", width: "w-32", align: "right" },
] as const;
