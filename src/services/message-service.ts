/** 主题 / 队列 / 消息接口，对应 `src-tauri/src/commands/message.rs`。 */

import { call } from "./ipc";
import type { QueueInfo, TopicInfo } from "@/types/broker";
import type { OrphanScanScope, OrphanTopicPage } from "@/types/orphan";
import type {
  BindingKey,
  BindingSpec,
  ExchangeSpec,
  QueueDetail,
  RabbitMqTopology,
} from "@/types/topology";
import type {
  MessageDetail,
  MessagePage,
  MessageQuery,
  SendOutcome,
  SendRequest,
} from "@/types/message";

export const messageService = {
  listTopics: (id: string) => call<TopicInfo[]>("list_topics", { id }),

  listQueues: (id: string) => call<QueueInfo[]>("list_queues", { id }),

  /** RabbitMQ 交换机 + 绑定 + 队列，一次拿全，避免页面上半新半旧。 */
  loadTopology: (id: string) => call<RabbitMqTopology>("load_topology", { id }),

  /** RabbitMQ 队列详情：状态、速率、参数、绑定来源。 */
  getQueue: (id: string, queue: string) => call<QueueDetail>("get_queue", { id, queue }),

  /** 清空队列中的消息（保留队列）。 */
  purgeQueue: (id: string, queue: string) => call<void>("purge_queue", { id, queue }),

  /** 删除队列；非空队列会被服务端拒绝。 */
  deleteQueue: (id: string, queue: string) => call<void>("delete_queue", { id, queue }),

  /** 新建交换机。 */
  createExchange: (id: string, spec: ExchangeSpec) =>
    call<void>("create_exchange", { id, spec }),

  /** 删除交换机；交换机仍被绑定时会被服务端拒绝。 */
  deleteExchange: (id: string, name: string, internal: boolean) =>
    call<void>("delete_exchange", { id, name, internal }),

  /** 新建绑定。对已存在的同参数绑定是幂等操作。 */
  createBinding: (id: string, spec: BindingSpec) =>
    call<void>("create_binding", { id, spec }),

  /** 删除绑定。 */
  deleteBinding: (id: string, key: BindingKey) =>
    call<void>("delete_binding", { id, key }),

  /** 无消费组主题的候选主题名（只拉元数据，不碰水位）。 */
  listOrphanCandidates: (id: string) => call<string[]>("list_orphan_candidates", { id }),

  /** 按范围扫描没有消费组消费、仍在堆积的 Kafka 主题。 */
  listOrphanTopics: (id: string, scope: OrphanScanScope, offset?: number) =>
    call<OrphanTopicPage>("list_orphan_topics", { id, scope, offset }),

  listMessages: (query: MessageQuery) => call<MessagePage>("list_messages", { query }),

  getMessage: (id: string, messageId: string) =>
    call<MessageDetail>("get_message", { id, messageId }),

  sendMessage: (request: SendRequest) => call<SendOutcome>("send_message", { request }),
};
