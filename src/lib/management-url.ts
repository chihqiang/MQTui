/**
 * RabbitMQ 的管理 API 地址该填什么。
 *
 * 这个字段原来写着「（可选）」，可它撑起的东西一点不「可选」：队列、交换机、绑定、
 * 策略、参数、消费者、运行时、拓扑图、路由预览、队列名候选，全都走管理插件的 HTTP
 * API。留空的时候这些页面一齐变灰，报错还各说各的，用户不知道是少填了一格。
 *
 * 于是改成「按 Host 自动填、也能自己改」：
 * - 没填过：跟着 Host 与 TLS 走，`host` + `http:15672`，TLS 时 `https:15671`；
 * - 填过：不再自动改写。手填的地址代表用户知道得比我们多（反代、跳板、别的端口），
 *   一条「聪明」的规则把它覆盖掉，是最让人恼火的那种体贴；
 * - 清空：下一次改 Host 时重新跟着动。
 */

const DEFAULT_HTTP_PORT = 15672;
const DEFAULT_HTTPS_PORT = 15671;

/** TLS 一开，管理插件也走 https —— 它的默认端口是 15671，不是 15672。 */
export function managementUrlFor(host: string, tls: boolean): string {
  const trimmed = host.trim();
  if (!trimmed) return "";
  return tls
    ? `https://${trimmed}:${DEFAULT_HTTPS_PORT}`
    : `http://${trimmed}:${DEFAULT_HTTP_PORT}`;
}

/**
 * Host / TLS 变了之后，管理地址该跟着变成什么（表单在 Host / TLS 上打字时用）。
 *
 * 手动清空不归这里管：输入框的 onChange 收到空串时先如实留空，等用户去改 Host
 * 才由本函数把它接回来 —— 边打字边清掉用户刚删掉的框，是一种很难解释的倔。
 *
 * 只改「看起来还是自动填的那一个」：字段为空，或者正好等于用旧 Host / 旧 TLS
 * 推出来的值。后者是关键 —— 用户没动过这一格，它就不该停在上一台机器的地址上，
 * 否则连完 A 改成 B，面板会跑去问 A 要队列列表。
 */
export function followManagementUrl(
  current: string | undefined,
  previousHost: string,
  previousTls: boolean,
  nextHost: string,
  nextTls: boolean,
): string {
  const url = current?.trim() ?? "";
  if (url !== "" && url !== managementUrlFor(previousHost, previousTls)) return url;
  return managementUrlFor(nextHost, nextTls);
}

/** 存盘前的那一步：空串是「不用管理插件」，没填过就补上推出来的那个。 */
export function withManagementUrl<T extends { managementUrl?: string }>(
  config: T,
  inferred: string,
): T {
  return config.managementUrl === undefined ? { ...config, managementUrl: inferred } : config;
}
