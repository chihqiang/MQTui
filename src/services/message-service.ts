/** 主题 / 队列 / 消息接口，对应 `src-tauri/src/commands/message.rs`。 */

import { call } from "./ipc";
import type { QueueInfo, TopicInfo } from "@/types/broker";
import type {
  BatchDisposalOutcome,
  BatchDisposalRequest,
  DeadLetterRequest,
  DisposalCapabilities,
  DisposalOutcome,
  RedeliverRequest,
  ResendOutcome,
  ResendRequest,
} from "@/types/disposal";
import type { ConsumerGraph } from "@/types/consumer-graph";
import type { ConsumerLinks, DisconnectRequest } from "@/types/consumer-link";
import type { OrphanScanScope, OrphanTopicPage } from "@/types/orphan";
import type { TopologyGraph } from "@/types/topology-graph";
import type { TopologyInsight } from "@/types/topology-insight";
import type {
  BindingKey,
  BindingSpec,
  ExchangeSpec,
  QueueDetail,
  RabbitMqTopology,
} from "@/types/topology";
import type {
  MessageDetail,
  MessageLocate,
  MessagePage,
  MessageQuery,
  MessageSearch,
  SendOutcome,
  SendRequest,
} from "@/types/message";

export const messageService = {
  listTopics: (id: string) => call<TopicInfo[]>("list_topics", { id }),

  listQueues: (id: string) => call<QueueInfo[]>("list_queues", { id }),

  /** RabbitMQ 交换机 + 绑定 + 队列，一次拿全，避免页面上半新半旧。 */
  loadTopology: (id: string) => call<RabbitMqTopology>("load_topology", { id }),

  /** 交换机到队列的路由估算：可达队列、死路交换机、堆积无消费者的队列。 */
  loadTopologyInsight: (id: string) =>
    call<TopologyInsight>("load_topology_insight", { id }),

  /**
   * RabbitMQ 拓扑图：交换机与队列的分层布局 + 连线。
   * 布局在后端算完（环、同名节点这类规则不该写在渲染层），这里只取结果。
   */
  loadTopologyGraph: (id: string) => call<TopologyGraph>("load_topology_graph", { id }),
  loadConsumerGraph: (id: string) => call<ConsumerGraph>("load_consumer_graph", { id }),

  /** RabbitMQ 队列详情：状态、速率、参数、绑定来源。 */
  getQueue: (id: string, queue: string) => call<QueueDetail>("get_queue", { id, queue }),

  /** 队列到消费者的连线：每个队列被谁消费、预取与未确认情况。 */
  listQueueConsumers: (id: string) => call<ConsumerLinks>("list_queue_consumers", { id }),

  /**
   * 断开一个消费者。服务端会关掉它所在的 channel，对端立刻失去这个消费入口。
   * 因此 `confirm` 必须与队列名完全一致——这是后端强制的确认项，不是防呆提示。
   */
  disconnectConsumer: (request: DisconnectRequest) =>
    call<void>("disconnect_consumer", { request }),

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

  /** Kafka 按 key / 时间区间定位消息。顺序扫描，不是索引查询。 */
  locateMessages: (request: MessageLocate) =>
    call<MessageSearch>("locate_messages", { request }),

  getMessage: (id: string, messageId: string) =>
    call<MessageDetail>("get_message", { id, messageId }),

  sendMessage: (request: SendRequest) => call<SendOutcome>("send_message", { request }),

  /** 一条 RabbitMQ 消息的处置能力：能不能重投 / 进死信，以及不能的原因。 */
  getDisposalCapabilities: (id: string, messageId: string) =>
    call<DisposalCapabilities>("get_disposal_capabilities", { id, messageId }),

  /** 重新投递：发布一份到目标交换机，确认落地后原消息才从队列消失。 */
  redeliverMessage: (request: RedeliverRequest) =>
    call<DisposalOutcome>("redeliver_message", { request }),

  /**
   * 批量处置：对同一个队列里的多条消息执行同一个动作。
   *
   * 返回逐条结果而不是成败二选一——批量操作不可回滚，
   * 只说「失败」会让人完全不知道哪几条已经离开了队列。
   */
  batchDisposeMessages: (request: BatchDisposalRequest) =>
    call<BatchDisposalOutcome>("batch_dispose_messages", { request }),

  /**
   * 重试「没放回队列」的那批消息：只放回，不处置。
   *
   * 与批量处置分开成一个接口，是因为误把它当成「再处置一次」的代价太大：
   * 这些是用户**没选中**的消息，被投出去就是凭空多出来的副本。
   */
  retryStrandedMessages: (request: BatchDisposalRequest) =>
    call<BatchDisposalOutcome>("retry_stranded_messages", { request }),

  /** 移入死信：目标交换机来自队列声明的 `x-dead-letter-exchange`。 */
  deadLetterMessage: (request: DeadLetterRequest) =>
    call<DisposalOutcome>("dead_letter_message", { request }),

  /** Kafka 重发：用同样的 key / 内容再写一条新消息，原消息不动。 */
  resendMessage: (request: ResendRequest) =>
    call<ResendOutcome>("resend_message", { request }),
};
