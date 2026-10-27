/**
 * 策略编辑的界面态：纯函数，不发请求。
 *
 * 校验与后果说明的权威实现在后端 `domain/policy.rs`，这里是它的前端影子 ——
 * 只做「这一行能不能编辑」「有没有改动」这类界面判断。真正的校验以
 * `preview_policy` 的返回为准，两边各写一套完整校验必然会漂移。
 */

import type {
  DefinitionEntry,
  PolicyApplyTo,
  PolicyInfo,
  PolicySpec,
} from "../types/policy.ts";

/** 生效范围的可选项与说明。 */
export const APPLY_TO_OPTIONS: { value: PolicyApplyTo; label: string; hint: string }[] = [
  { value: "queues", label: "队列", hint: "只作用于匹配的队列" },
  { value: "exchanges", label: "交换机", hint: "只作用于匹配的交换机" },
  { value: "all", label: "队列 + 交换机", hint: "同时作用于匹配的队列与交换机" },
];

/**
 * 常用策略键的候选清单。
 *
 * 用途只有一个：给「还没配过这一项」的策略一个入口，不必记住键名拼写。
 * 顺序按排查时最常改的排，不是字母序。不在表里的键照常可以手填 ——
 * 插件会注册自己的键，白名单拦下来会挡住合法用法。
 */
export const COMMON_DEFINITION_KEYS: { key: string; label: string; hint: string }[] = [
  { key: "x-message-ttl", label: "消息 TTL（毫秒）", hint: "消息在队列里最多停留多久，超时后被丢弃" },
  { key: "x-expires", label: "队列过期（毫秒）", hint: "队列闲置多久后自动删除" },
  { key: "x-max-length", label: "队列长度上限", hint: "超出后按 x-overflow 策略处理" },
  { key: "x-max-length-bytes", label: "队列容量上限（字节）", hint: "按总字节数限制，和条数上限独立" },
  { key: "x-overflow", label: "溢出行为", hint: "drop-head / reject-publish / reject-publish-dlx" },
  { key: "x-dead-letter-exchange", label: "死信交换机", hint: "被拒绝或过期的消息转投到这里" },
  { key: "x-dead-letter-routing-key", label: "死信 routing key", hint: "留空沿用消息原始 routing key" },
  { key: "x-max-priority", label: "最大优先级", hint: "声明队列后不可更改，改这一项要重建队列" },
  { key: "x-single-active-consumer", label: "单活消费者", hint: "true 时同一队列只允许一个消费者收消息" },
  { key: "x-queue-mode", label: "队列模式", hint: "lazy 把消息尽量留在磁盘" },
  { key: "ha-mode", label: "镜像模式", hint: "all / exactly / nodes" },
  { key: "ha-params", label: "镜像参数", hint: "exactly 给数量，nodes 给节点列表（JSON 数组）" },
  { key: "ha-sync-mode", label: "镜像同步", hint: "automatic / manual" },
];

/** 编辑器里的一行定义项。`draft` 是用户正在输入的值。 */
export interface DefinitionRow {
  key: string;
  value: string;
  draft: string;
}

/** 由策略定义生成编辑行。 */
export function toRows(definition: DefinitionEntry[]): DefinitionRow[] {
  return definition.map((entry) => ({ ...entry, draft: entry.value }));
}

/** 由编辑行还原成提交用的定义项；键为空的行直接丢弃。 */
export function fromRows(rows: DefinitionRow[]): DefinitionEntry[] {
  return rows
    .map((row) => ({ key: row.key.trim(), value: row.draft.trim() }))
    .filter((entry) => entry.key.length > 0);
}

/** 某一行是否有未保存的改动。 */
export function isDirty(row: DefinitionRow): boolean {
  return row.draft !== row.value;
}

/** 空表单的初值。 */
export function emptySpec(): PolicySpec {
  return {
    name: "",
    pattern: "",
    priority: 0,
    applyTo: "queues",
    definition: [],
  };
}

/** 把既有策略转成可编辑的表单值。 */
export function specFromPolicy(policy: PolicyInfo): PolicySpec {
  return {
    name: policy.name,
    pattern: policy.pattern,
    priority: policy.priority,
    applyTo: policy.applyTo,
    definition: policy.definition.map((entry) => ({ ...entry })),
  };
}

/**
 * 取值必须是整数的策略键。**按全等匹配，不做前缀判断**：
 * `x-max-length-bytes` 里含有 `x-max-length`，用 `includes` 会把它一起算进来，
 * 一个合法的字节数上限就被判成「必须是整数」。
 *
 * 与后端 `domain/policy.rs` 的 `normalize_value` 保持同一份清单。
 */
const INTEGER_KEYS = new Set([
  "x-message-ttl",
  "x-expires",
  "x-max-length",
  "x-max-length-bytes",
  "x-max-priority",
  "x-delivery-limit",
  "message-ttl",
  "expires",
  "max-length",
  "max-length-bytes",
  "max-priority",
  "delivery-limit",
]);

/** 固定枚举取值的键。写错不会报错，只是策略空转，所以提前拦。 */
const ENUM_KEYS: Record<string, string[]> = {
  "x-overflow": ["drop-head", "reject-publish", "reject-publish-dlx"],
  "x-queue-master-locator": ["min-masters", "client-local", "random"],
};

/**
 * 本地预检：只拦「服务端必然拒绝」和「提交了也没意义」两类问题。
 *
 * 正则语法不在这里校验 —— 本地放行、服务端报错，比本地错杀好：
 * 两边正则方言不完全一致，误判会让人反复改一个本来正确的东西。
 */
export function validateSpec(spec: PolicySpec): string | null {
  if (!spec.name.trim()) return "策略名称不能为空";
  if (spec.name.trim() !== spec.name) return "策略名称首尾不能有空白字符";
  if (spec.definition.length === 0)
    return "策略至少要包含一项定义，否则规则不产生任何效果";
  for (const entry of spec.definition) {
    const key = entry.key.trim();
    const value = entry.value.trim();
    if (!key) return "定义项的键不能为空";
    if (!value)
      return `\`${entry.key}\` 的值不能为空；不想要这一项请删除该行`;

    const allowed = ENUM_KEYS[key];
    if (allowed && !allowed.includes(value))
      return `\`${key}\` 只接受 ${allowed.join(" / ")}`;

    if (INTEGER_KEYS.has(key)) {
      // 只判「是不是整数」，不判正负：负数由后端统一说明，
      // 这里多写一条就多一处会和后端漂移的规则。
      if (!/^-?\d+$/.test(value))
        return `\`${key}\` 必须是整数，当前值 \`${value}\``;
    }
  }
  return null;
}

/** 定义项摘要，列表行里用：只显示前两项，其余折成「+N」。 */
export function describeDefinition(definition: DefinitionEntry[]): string {
  if (definition.length === 0) return "（空定义）";
  const head = definition
    .slice(0, 2)
    .map((entry) => `${entry.key}=${entry.value}`)
    .join(" · ");
  const rest = definition.length - 2;
  return rest > 0 ? `${head} · +${rest}` : head;
}

/** 影响面文案。估算值一律带「约」，不让它看起来像精确数字。 */
export function describeImpact(impact: { queues: number; exchanges: number }): string {
  const parts: string[] = [];
  if (impact.queues > 0) parts.push(`约 ${impact.queues} 个队列`);
  if (impact.exchanges > 0) parts.push(`约 ${impact.exchanges} 个交换机`);
  return parts.length ? `将影响 ${parts.join("、")}` : "当前没有资源命中这个模式";
}
