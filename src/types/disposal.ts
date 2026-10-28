/** 与 `src-tauri/src/domain/redeliver.rs` 一一对应的领域类型。 */

/** 重投请求：把队列里的一条消息再发一次。 */
export interface RedeliverRequest {
  connectionId: string;
  /** 消息 ID（`queue:deliveryTag`）。 */
  messageId: string;
  /** 目标交换机，空串表示默认交换机。 */
  exchange: string;
  /** 目标 routing key；留空时沿用消息的原始 routing key。 */
  routingKey: string;
}

/** 移入死信请求。 */
export interface DeadLetterRequest {
  connectionId: string;
  messageId: string;
}

/** 处置结果：消息被送到了哪里。 */
export interface DisposalOutcome {
  /** `redeliver` | `deadLetter`。 */
  action: string;
  exchange: string;
  routingKey: string;
  detail: string;
}

/** 一条消息的处置能力。 */
export interface DisposalCapabilities {
  canRedeliver: boolean;
  canDeadLetter: boolean;
  /** 不能操作的原因，`key` 是 `redeliver` / `deadLetter`。 */
  reasons?: { key: string; value: string }[];
}

/**
 * Kafka 消息重发请求。对应 `src-tauri/src/domain/resend.rs`。
 *
 * Kafka 的消息按 offset 写在日志里，重发只能是「再写一条新消息」，
 * 原消息不会消失——措辞上不要用「移动」。
 */
export interface ResendRequest {
  connectionId: string;
  /** 原消息 ID（`topic:partition:offset`）。 */
  messageId: string;
  /** 目标 topic，留空沿用原 topic。 */
  topic: string;
  /** 消息 key，留空沿用原 key。 */
  key?: string;
  /**
   * 原消息 key 的 base64。
   *
   * 与 `payloadBase64` 同理：key 只参与分区哈希，不必是 UTF-8。把它当字符串
   * 来回搬一次（`\xff` → `\u{fffd}`），同一条 key 就落到别的分区上了——
   * 而「落点有没有变」正是重发要回答的问题。
   */
  keyBase64?: string;
  /** 消息内容，留空沿用原内容。 */
  payload?: string;
  /**
   * 原消息内容的 base64。
   *
   * 表单里没改内容时原样带回：`payload` 是文本，二进制内容（Avro / Protobuf）
   * 经过一次 UTF-8 解码就再也回不到原样，重发会静默改掉消息体。
   */
  payloadBase64?: string;
  /** 是否带上原消息的 headers。 */
  keepHeaders: boolean;
}

/** 重发结果：新消息写到哪了。 */
export interface ResendOutcome {
  topic: string;
  partition: number;
  offset: number;
  /** 落点提示：同一条 key 换了分区时会说明原因。 */
  note: string;
}

/** 批量处置动作，与单条处置共用同一套动作名。 */
export type DisposalAction = "redeliver" | "deadLetter";

/** 批量处置请求。对应 `domain/redeliver.rs` 的 `BatchDisposalRequest`。 */
export interface BatchDisposalRequest {
  connectionId: string;
  action: DisposalAction;
  /** 目标消息 ID（`queue:deliveryTag`），顺序即回报顺序。 */
  messageIds: string[];
  /** 重投的目标交换机（仅 redeliver 使用），空串表示默认交换机。 */
  exchange: string;
  /** 重投的目标 routing key，留空沿用各条消息自己的原始 routing key。 */
  routingKey: string;
  /**
   * 消息所在的队列。正常批量处置时留空（由消息 ID 推出来）；
   * 「重试没放回队列的那批」时必填 —— 那批消息的队列不能按选中的几条去推。
   */
  queue?: string;
}

/**
 * 单条消息的批量处置结局。
 *
 * `failed` 意味着这条消息**仍在队列里**——批量处置按「一条失败即停」执行，
 * 后面没轮到的消息会被标成 `skipped`，同样原样留在队列。
 */
export type BatchItemStatus = "ok" | "failed" | "skipped";

export interface BatchDisposalItem {
  messageId: string;
  status: BatchItemStatus;
  /** 成功时是送去的目标，失败 / 跳过时是原因。 */
  detail: string;
}

/** 批量处置汇总：逐条结果 + 三种结局的计数。 */
export interface BatchDisposalOutcome {
  action: string;
  items: BatchDisposalItem[];
  succeeded: number;
  failed: number;
  skipped: number;
  /** 顶部一句话结论，避免用户自己去数三行数字。 */
  note: string;
  /**
   * 顺带取出、却没能放回队列的消息 ID（`queue:deliveryTag`）。
   *
   * 这些不在 `items` 里（用户没选它们），但也没回到队列：
   * 仍被本次消费通道持有，连接关闭后才会被退回。非空必须显示出来。
   *
   * 给的是完整 ID 列表而不是计数：只有一个数字，界面除了说一句
   * 「有 3 条卡住了」什么都做不了。带上 ID 才有「重试这批」可点。
   */
  stranded?: string[];
  /**
   * 这批卡住的消息能不能重试放回。
   *
   * `undefined` 表示没有卡住的消息；`false` 表示卡住了但点不动——
   * 那就不该给一个按下去必然失败的按钮，而要让人知道去哪儿处理。
   */
  retryable?: boolean;
}

/** 一批最多处置多少条，与后端 `MAX_BATCH_SIZE` 保持一致。 */
export const MAX_BATCH_SIZE = 50;

/** 单条消息的处置动作。与 `DisposalAction` 同义，消息页内部用它区分两种弹窗。 */
export type MessageDisposalKind = DisposalAction;
