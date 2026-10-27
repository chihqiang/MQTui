/**
 * 与 `src-tauri/src/domain/broker.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

export type BrokerKind = "kafka" | "rabbitMq";

/** 面板能力：前端据此拼装菜单，不按中间件写死菜单。 */
export type BrokerCapability =
  | "overview"
  | "topics"
  | "consumerGroups"
  | "orphanTopics"
  | "queues"
  | "exchanges"
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
}

export interface QueueInfo {
  name: string;
  vhost: string;
  consumers: number;
  /** 队列中的消息数，仅管理 API 能提供。 */
  messages: number;
}
