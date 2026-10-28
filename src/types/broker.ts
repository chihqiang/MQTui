/**
 * 与 `src-tauri/src/domain/broker.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

export type BrokerKind = "kafka" | "rabbitMq";

/** 面板能力：前端据此拼装菜单，不按中间件写死菜单。 */
export type BrokerCapability =
  | "overview"
  | "cluster"
  | "runtime"
  | "topics"
  | "consumerGroups"
  | "offsetReset"
  | "orphanTopics"
  | "queues"
  | "admin"
  | "access"
  | "policies"
  | "parameters"
  | "exchanges"
  | "consumers"
  | "consumerOwnership"
  | "routing"
  | "topologyGraph"
  | "consumerGraph"
  | "messages"
  | "produce";

export type TlsMode = "disabled" | "optional" | "required";

export type SaslMechanism = "none" | "plain" | "scramSha256" | "scramSha512";

export interface KafkaAuth {
  mechanism: SaslMechanism;
  username: string;
  password: string;
}

export interface KafkaConfig {
  brokers: string[];
  tls: TlsMode;
  auth: KafkaAuth;
  /** 附加的 librdkafka 配置项，键值原样透传。 */
  options: Record<string, string>;
}

export interface RabbitMqAuth {
  username: string;
  password: string;
  vhost: string;
}

export interface RabbitMqConfig {
  host: string;
  port: number;
  tls: TlsMode;
  auth: RabbitMqAuth;
  /** 管理插件地址（如 http://localhost:15672）；留空则队列列表不可用。 */
  managementUrl?: string;
}

/** 邻接标签（adjacently tagged）：`{ kind: "kafka", ...config }`。 */
export type ConnectionConfig =
  | ({ kind: "kafka" } & KafkaConfig)
  | ({ kind: "rabbitMq" } & RabbitMqConfig);

export interface ConnectionSummary {
  id: string;
  name: string;
  kind: BrokerKind;
  endpoint: string;
  active: boolean;
}

export interface PluginKind {
  kind: BrokerKind;
  displayName: string;
  capabilities: BrokerCapability[];
}

export interface KeyValue {
  key: string;
  value: string;
}

export interface Overview {
  title: string;
  items: KeyValue[];
}

export interface TopicInfo {
  name: string;
  partitions: number;
  replicationFactor?: number;
  /** 内部主题（`__consumer_offsets` 等）：删除与扩容都没有意义。 */
  internal?: boolean;
}

export interface QueueInfo {
  name: string;
  vhost: string;
  consumers: number;
  /** 队列中的消息数，仅管理 API 能提供。 */
  messages: number;
}

/** 一种中间件在界面上的固定说法：一句人话 + 表单里的默认端口。 */
export interface BrokerKindMeta {
  /** 一句人话，说这一种中间件能看什么。 */
  summary: string;
  /** 表单默认端口；Kafka 的「端口」只是地址里的提示，RabbitMQ 的是管理 API。 */
  port: string;
}

/**
 * 中间件的界面元信息。
 *
 * 首页的卡片与向导的第一步都在说同一件事（「Kafka / 主题、分区、消费组与位点 /
 * 9092」），原先各页面自己抄了一份。抄出来的两份已经不一致了：向导里的 RabbitMQ
 * 端口写成 `15672（管理 API）`，首页写成 `15672（管理 API）`，但 Kafka 的接线默认值
 * 却在另外两处又写了一遍。这里放成一份，页面只负责排版。
 */
export const BROKER_META: Record<BrokerKind, BrokerKindMeta> = {
  kafka: { summary: "主题、分区、消费组与位点", port: "9092" },
  rabbitMq: { summary: "队列、交换机、绑定与消息处置", port: "15672（管理 API）" },
};

/** 连接表单里「TLS」下拉的选项。 */
export const TLS_OPTIONS: { value: TlsMode; label: string }[] = [
  { value: "disabled", label: "不启用" },
  { value: "required", label: "强制 TLS" },
];

/** 连接表单里「SASL 机制」下拉的选项。 */
export const SASL_OPTIONS: { value: SaslMechanism; label: string }[] = [
  { value: "none", label: "无" },
  { value: "plain", label: "PLAIN" },
  { value: "scramSha256", label: "SCRAM-SHA-256" },
  { value: "scramSha512", label: "SCRAM-SHA-512" },
];
