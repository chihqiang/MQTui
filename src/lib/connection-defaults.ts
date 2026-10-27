/**
 * 连接表单的默认值与端点措辞。
 *
 * 这几件事原先散在三个页面里，而且是**同一份逻辑抄了三遍**：
 * `connect-page` 的 `formDefaults`、`connect-wizard` 的 `defaultsFor`、两个表单文件
 * 各自的 `initial()`，四处拼出来的 `ConnectionConfig` 字段一模一样。抄写版的代价
 * 已经付过一次：`RabbitMqConfig` 加了 `managementUrl` 之后，只有一处补齐了它，
 * 另外三处靠可选字段躲过类型检查 —— 类型没拦住，是因为缺的字段正好是可选的。
 *
 * 所以这里只有一个 `defaultConnection`：默认值 + `kind`（`ConnectionConfig` 是邻接
 * 标签，类型本身带不上）拼成一份完整配置。表单要预填草稿，就再叠一次草稿；要换成
 * 历史里的地址，就再叠一次地址。页面那边不再各留一份。
 */
import { BROKER_META } from "../types/broker.ts";
import type { BrokerKind, ConnectionConfig, SaslMechanism, TlsMode } from "../types/broker.ts";

/** 表单初始值：本机的默认地址，够点「连接」就能连上一台本地的。 */
export const CONNECTION_DEFAULTS = {
  kafka: {
    brokers: "127.0.0.1:9092",
    mechanism: "none" as SaslMechanism,
    tls: "disabled" as TlsMode,
  },
  rabbitMq: {
    host: "127.0.0.1",
    port: 5672,
    tls: "disabled" as TlsMode,
    username: "guest",
    password: "guest",
    vhost: "/",
  },
};

/**
 * 默认配置。
 *
 * 重载是为了让调用处拿到精确的分支类型：`withEndpoint("kafka", ...)` 之后要读
 * `.brokers`，不必再判一次 `kind`。
 */
export function defaultConnection(kind: "kafka"): Extract<ConnectionConfig, { kind: "kafka" }>;
export function defaultConnection(kind: "rabbitMq"): Extract<ConnectionConfig, { kind: "rabbitMq" }>;
export function defaultConnection(kind: BrokerKind): ConnectionConfig;
export function defaultConnection(kind: BrokerKind): ConnectionConfig {
  if (kind === "kafka") {
    return {
      kind: "kafka",
      brokers: [CONNECTION_DEFAULTS.kafka.brokers],
      tls: CONNECTION_DEFAULTS.kafka.tls,
      auth: { mechanism: CONNECTION_DEFAULTS.kafka.mechanism, username: "", password: "" },
      options: {},
    };
  }
  return {
    kind: "rabbitMq",
    host: CONNECTION_DEFAULTS.rabbitMq.host,
    port: CONNECTION_DEFAULTS.rabbitMq.port,
    tls: CONNECTION_DEFAULTS.rabbitMq.tls,
    auth: {
      username: CONNECTION_DEFAULTS.rabbitMq.username,
      password: CONNECTION_DEFAULTS.rabbitMq.password,
      vhost: CONNECTION_DEFAULTS.rabbitMq.vhost,
    },
  };
}

/** 一份连接配置 → 人认得出的地址。历史行与报错摘要共用同一份措辞。 */
export function endpointOf(config: ConnectionConfig): string {
  return config.kind === "kafka" ? config.brokers.join(", ") : `${config.host}:${config.port}`;
}

/**
 * 把 `host:port` 拆回配置的地址那两格。
 *
 * 只认一种形态：最后一个冒号后面是一段纯数字。其余（`rabbit:`、IPv6 的 `::1`）
 * 一律整段当主机名 —— 猜错了会连到一台根本不存在的机器上，还不如让用户看一眼再改。
 * `[::1]:5672` 这种带方括号的写法仍然拆得出来，方括号在主机名里去掉。
 */
export function splitHostPort(endpoint: string): { host: string; port?: number } {
  const first = endpoint.split(",")[0]?.trim() ?? "";
  if (first.startsWith("[")) {
    const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(first);
    if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) };
    return { host: first.replace(/^\[|\]$/g, "") };
  }
  // 裸 IPv6 有多个冒号，`lastIndexOf` 拆出来的「端口」是地址的一部分。
  if (first.indexOf(":") !== first.lastIndexOf(":")) return { host: first };
  const match = /^(.*):(\d+)$/.exec(first);
  if (!match) return { host: first };
  return { host: match[1], port: Number(match[2]) };
}

/**
 * 一份只有地址的配置（历史里存不下口令，也存不下 TLS/SASL）。
 *
 * 底子是 `base`（通常是「草稿或默认值」），只替换地址那一格 —— 别的字段编造出来
 * 会让用户以为那是他上次填的。RabbitMQ 的端口能从地址里读出来时跟着改，读不出来
 * 就沿用底子里的值。
 */
export function withEndpoint(base: ConnectionConfig, endpoint: string): ConnectionConfig {
  if (base.kind === "kafka") {
    return {
      ...base,
      brokers: endpoint.split(",").map((part) => part.trim()).filter(Boolean),
    };
  }
  const { host, port } = splitHostPort(endpoint);
  return { ...base, host: host || base.host, port: port ?? base.port };
}

/** 一种中间件在界面上的说法。 */
export function brokerMetaOf(kind: BrokerKind): { summary: string; port: string } {
  return BROKER_META[kind] ?? { summary: "", port: "" };
}

