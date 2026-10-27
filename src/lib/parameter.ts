/**
 * 参数编辑的界面态与提示文案：纯函数，不发请求。
 *
 * 校验的权威实现在后端 `domain/parameter.rs`，这里是它的前端影子 ——
 * 只做「能不能点保存」「这一行是什么组件」这类界面判断。
 * 真正的阻断以 `review_parameter_spec` 的返回为准，两边各写一套必然会漂移。
 */

import type { ParameterComponent, ParameterInfo } from "../types/parameter.ts";

/** 组件的中文名与说明。顺序按「配置时最常碰到的排前面」。 */
export const COMPONENT_OPTIONS: {
  value: ParameterComponent;
  label: string;
  hint: string;
}[] = [
  {
    value: "federation-upstream",
    label: "联邦上游",
    hint: "从另一个 broker 拉消息的连接定义，最少要有 uri",
  },
  {
    value: "federation-upstream-set",
    label: "联邦上游集",
    hint: "把多个上游编成一组，形状固定为 {\"value\": [{...}]}",
  },
  {
    value: "shovel",
    label: "铲子",
    hint: "把消息从一个地址搬到另一个地址，必须有 src-uri 与 dest-uri",
  },
  {
    value: "runtime",
    label: "运行时参数",
    hint: "节点级参数（如 cluster_name），只能放在默认 vhost `/` 下",
  },
];

const COMPONENT_LABELS = new Map(COMPONENT_OPTIONS.map((item) => [item.value, item.label]));

/** 组件中文名。插件注册的未知组件退回原始名，不当成错误。 */
export function componentLabel(component: string): string {
  return COMPONENT_LABELS.get(component as ParameterComponent) ?? component;
}

/** 组件对应的路径段是否已知。 */
export function isKnownComponent(component: string): component is ParameterComponent {
  return COMPONENT_LABELS.has(component as ParameterComponent);
}

/** 节点级参数只认默认 vhost。 */
export function requiresDefaultVhost(component: ParameterComponent): boolean {
  return component === "runtime";
}

/**
 * 换组件时要跳过的坑：`runtime` 在业务 vhost 下服务端照收但不生效。
 * 切到 runtime 时把 vhost 拨回 `/`，切走时再留空交给用户填。
 */
export function vhostAfterSwitch(component: ParameterComponent, current: string): string {
  if (requiresDefaultVhost(component)) return "/";
  return current === "/" ? "" : current;
}

/** 模板：不同组件的最小可用骨架，省得从零背字段名。 */
export function templateFor(component: ParameterComponent): string {
  const template =
    component === "federation-upstream"
      ? { uri: "amqp://user:password@remote-host:5672", "prefetch-count": 100, reconnect_delay: 5 }
      : component === "federation-upstream-set"
        ? { value: [{ upstream: "upstream-name" }] }
        : component === "shovel"
          ? {
              "src-uri": "amqp://user:password@source-host:5672",
              "src-queue": "source-queue",
              "dest-uri": "amqp://user:password@dest-host:5672",
              "dest-queue": "dest-queue",
              "ack-mode": "on-confirm",
            }
          : "cluster-name";
  return JSON.stringify(template, null, 2);
}

/**
 * 值的可读摘要，列表行里用。
 *
 * 后端也会给一份 `summary`（`ParameterInfo::summary`），但那是给人看的一句话；
 * 这里只负责把编辑框里的 JSON 文本压成一行，用于「快速扫一眼有没有填错」。
 */
export function compactValue(text: string, max = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 这条参数会不会主动拨号出去（联邦、铲子）。 */
export function dialsOut(component: string): boolean {
  return (
    component === "federation-upstream" ||
    component === "federation-upstream-set" ||
    component === "shovel"
  );
}

/** 参数按组件分组，界面分块展示。保持组件在 `COMPONENT_OPTIONS` 里的顺序。 */
export function groupByComponent(
  parameters: ParameterInfo[],
): { component: string; items: ParameterInfo[] }[] {
  const buckets = new Map<string, ParameterInfo[]>();
  for (const parameter of parameters) {
    const list = buckets.get(parameter.component) ?? [];
    list.push(parameter);
    buckets.set(parameter.component, list);
  }
  const order = COMPONENT_OPTIONS.map((option) => option.value as string);
  return [...buckets.entries()]
    .sort(([left], [right]) => rank(order, left) - rank(order, right))
    .map(([component, items]) => ({ component, items }));
}

function rank(order: string[], component: string): number {
  const index = order.indexOf(component);
  // 未知组件（插件注册的）排在已知之后，但不丢弃。
  return index === -1 ? order.length : index;
}

/** 关键字过滤：名称、vhost、组件名、值文本都参与匹配。 */
export function filterParameters(parameters: ParameterInfo[], keyword: string): ParameterInfo[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return parameters;
  return parameters.filter((parameter) =>
    [parameter.name, parameter.vhost, parameter.component, JSON.stringify(parameter.value)]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * 参数值的一行摘要。
 *
 * 只取最要紧的一两个字段：完整 JSON 留在编辑弹窗里看。URI 一律打码 ——
 * 后端也做了一遍（`domain::parameter::redact_uri`），这里再做一次是因为
 * 摘要文本会直接进 DOM，漏一次就是把口令印在屏幕上。
 */
export function summarizeParameter(parameter: ParameterInfo): string {
  const value = parameter.value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["uri", "src-uri", "dest-uri", "prefetch-count", "value"]) {
      if (record[key] !== undefined) parts.push(`${key}=${renderPart(record[key])}`);
    }
    if (parts.length) return parts.join(" · ");
  }
  return JSON.stringify(value ?? null);
}

/** 摘要里的单个值：字符串先打码，数组只报个数。 */
export function renderPart(value: unknown): string {
  if (typeof value === "string") return maskCredentials(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  return JSON.stringify(value);
}

/** URI 里的口令打码：`amqp://user:pass@host/vhost` → `amqp://user:***@host/vhost`。 */
export function maskCredentials(uri: string): string {
  const match = /^([a-z+]+:\/\/)([^@/]+)@(.+)$/i.exec(uri);
  if (!match) return uri;
  const [, scheme, userinfo, rest] = match;
  const user = userinfo.split(":")[0];
  return userinfo.includes(":") ? `${scheme}${user}:***@${rest}` : uri;
}
