/** 与 `src-tauri/src/domain/message.rs` 一一对应的领域类型。 */

export interface MessageHeader {
  key: string;
  /**
   * 值。`null` / 缺省表示「这个 header 存在，但没有值」。
   *
   * 空串和「没有值」不是一回事：AMQP 侧一个是长度为 0 的字符串，
   * 一个是 `void`，headers 交换机与消费端都区别对待。
   */
  value?: string | null;
}

export interface MessageQuery {
  connectionId: string;
  /** Kafka 为 topic，RabbitMQ 为 queue。 */
  target: string;
  limit?: number;
  /** 上一页返回的游标，原样回传表示「加载更多」；缺省表示从头读。 */
  cursor?: string;
  /**
   * 只看某个分区（仅 Kafka）。
   *
   * 它只决定**首次读取**挑哪些分区；带游标续读时由游标决定进度，
   * 所以「加载更多」不需要重复传。
   */
  partition?: number;
}

export interface MessageSummary {
  id: string;
  key?: string;
  topic?: string;
  partition?: number;
  offset?: number;
  timestamp?: number;
  preview: string;
  size?: number;
  /** 完整 payload，仅 RabbitMQ 列表带（AMQP 无法按 deliveryTag 事后回源）。 */
  payload?: string;
}

export interface MessageDetail {
  summary: MessageSummary;
  payload: string;
  payloadBase64?: string;
  /**
   * 消息 key 的原始字节（base64），**只在 key 不是合法 UTF-8 时才有**。
   *
   * 文本 key 看 `summary.key` 就够了；二进制 key 只看文本会被读成 `�`，
   * 重发就换了分区。
   */
  keyBase64?: string;
  headers: MessageHeader[];
}

export interface MessagePage {
  items: MessageSummary[];
  /** 是否还有更多数据可读。 */
  hasMore: boolean;
  /** 下一页游标。 */
  cursor?: string;
  source: string;
}

/** 定位条件：Kafka 日志里按 key / 时间区间找消息。 */
export interface MessageLocate {
  connectionId: string;
  target: string;
  /** 精确匹配的 key；空串视为不按 key 过滤。 */
  key?: string;
  /**
   * 内容片段，包含匹配、不区分大小写。
   * 必须与时间区间一起用：内容匹配要逐条解码消息体，没有区间就是全量扫日志。
   */
  content?: string;
  /** 时间区间起点（毫秒，含）。 */
  after?: number;
  /** 时间区间终点（毫秒，含）。 */
  before?: number;
  limit?: number;
  /** 上一页返回的续扫游标，原样回传表示「接着上次停下的位置继续」。 */
  cursor?: string;
}

/** 定位结果。 */
export interface MessageSearch {
  items: MessageSummary[];
  /** 实际解码过的条数（含未命中），用于说明这次扫描的代价。 */
  scanned: number;
  /** 是否因扫描上限/时间预算提前结束。 */
  truncated: boolean;
  /** 扫描范围的人话说明。 */
  note: string;
  /** 续扫游标。缺失表示已经扫到日志尽头，没有更多可读。 */
  cursor?: string;
  /** 本次扫描起点说明（首次扫描 / 续扫 N 个分区 / 条件变化后从头扫）。 */
  resumedFrom?: string;
  /** 内容扫描的条数预算说明；只在按内容查找时出现。 */
  contentBudget?: string;
  /**
   * 条件对得上、但没有时间戳因而无法判断区间的消息说明。
   *
   * 与 `truncated` 分开：那个是「还没读完」，这个是「读到了但判不了」。
   * 合起来说会让用户以为再点一次「继续扫描」就能找到它们。
   */
  undated?: string;
}

/**
 * 发送请求：两种中间件各说各的，不是一张表单。
 *
 * 原来是一个扁平的 `{ target, key, exchange }`，字段按中间件互相忽略 ——
 * `exchange` 在 Kafka 下永远传 undefined，`key` 在 RabbitMQ 下永远是空。
 * 看起来只是多两个字段，实际是把「填了没用」写进了类型里：新加一种中间件时，
 * 没人知道哪些字段是它的。现在按 kind 分叉，缺字段是编译错误，不是运行时静默忽略。
 */
export type SendRequest = KafkaSendRequest | RabbitMqSendRequest;

/** Kafka：投到 topic，`key` 决定分区落点。 */
export interface KafkaSendRequest {
  kind: "kafka";
  connectionId: string;
  /** 目标 topic。 */
  topic: string;
  /** 消息 key；空着则由 partitioner 轮询选分区。 */
  key?: string;
  /**
   * 消息头。Kafka 的 record headers 原来在命令层被丢掉，
   * 于是「填了 trace-id、消费端看不到」——现在这一项真的会发出去。
   */
  headers: MessageHeader[];
  payload: string;
}

/** RabbitMQ：投到 exchange + routing key，由交换机决定去哪些队列。 */
export interface RabbitMqSendRequest {
  kind: "rabbitMq";
  connectionId: string;
  /** 目标交换机；空串表示默认交换机（按 routing key 直投同名队列）。 */
  exchange: string;
  /** routing key。 */
  routingKey: string;
  payload: string;
  /** 投递模式：持久化消息（`2`）在 broker 重启后仍在，非持久化（`1`）不在。 */
  deliveryMode: number;
  /** 内容类型，例如 `application/json`。缺省 `text/plain`。 */
  contentType?: string;
  /** 内容编码，例如 `gzip`。缺省不带。 */
  contentEncoding?: string;
  headers: MessageHeader[];
}

export interface SendOutcome {
  kind: string;
  detail: string;
  /**
   * 这次发送**没有确定结论**：消息可能已经写进去了（Kafka 超时一类）。
   *
   * 有它的时候界面上不能说「发送失败」，也不能把按钮当成「再点一次就好」——
   * 那正是在制造重复消息。
   */
  unsure?: boolean;
  /**
   * 这条连接上的 producer 保证被高级选项改掉时的提示（目前只有幂等）。
   *
   * 成功时也会带：`detail` 里的「已写入」容易被读成「以后也可以放心再点」，
   * 而幂等失效时这个假设不成立。
   */
  producerWarning?: string;
}

/** 一条消息最终能到达的队列。 */
export interface ReachableQueue {
  queue: string;
  /** 命中的绑定上的 routing key；fanout 交换机上为空串。 */
  routingKey: string;
  /** 经过交换机间转发才到达。 */
  viaExchange: boolean;
}

/**
 * 发送预览：这条消息会被投到哪些队列。
 *
 * 发送页唯一「静默失败」的形态是发到没人收的地方 —— publish 成功、
 * 界面无异常、消息消失。`warning` 为空才表示照常发即可。
 */
export interface SendRoute {
  /** 交换机名称；空串表示默认交换机。 */
  exchange: string;
  queues: ReachableQueue[];
  /** 交换机类型；交换机不存在时缺省。 */
  exchangeType?: string;
  warning?: string;
  /**
   * 判断所依据的事实是否齐备。
   *
   * `false` 时 `queues` 为空只代表「算不出来」，不代表「没人会收到」。
   * 缺省视为 `true`（后端老版本不会带这个字段）。
   */
  bindingsKnown?: boolean;
  /**
   * 比较不了的绑定参数（形如 `交换机/绑定目标:参数名`）。
   *
   * 绑定参数可以是数字、布尔、嵌套表，表单里的值只是字符串 —— 这类参数
   * 没法比，少比一个就可能少算一个队列，所以空结果不能当结论。
   */
  headersUnknownParameters?: string[];
}

/**
 * 列表行高（像素）。
 *
 * 虚拟列表必须知道准确行高才能算偏移量，而这个数曾经写死在定位面板里：
 * 一旦行高改了，越往下滚内容相对滚动位置偏得越多，滚一格视线跳一大截。
 * 与 `lib/list-view.ts` 的 `DENSITY_ROW_HEIGHT` 同一个道理，只是定位面板
 * 的行比表格行更高（带一条 payload 预览）。
 */
export const MESSAGE_ROW_HEIGHT = 38;

/** 消息页的两种形态：浏览当前 topic / 按条件扫一遍找消息。 */
export type MessageMode = "browse" | "locate";

/** 浏览与定位是两种不同的读法：一个往下翻，一个按条件扫。 */
export const MESSAGE_MODES: readonly { value: MessageMode; label: string; hint: string }[] = [
  { value: "browse", label: "浏览", hint: "读这个 topic 当前的消息" },
  { value: "locate", label: "按 key / 时间定位", hint: "顺序扫描分区，适合「找那条消息」" },
];

/** 消息详情弹窗的入参。 */
export interface MessageDetailProps {
  connectionId: string;
  message: MessageSummary;
  onClose: () => void;
  /**
   * 「按这个 key 继续找」：把这条消息的 key 带回定位面板。
   *
   * 详情是排查的十字路口 —— 看到一条可疑消息，下一步十有八九是「同一个 key 的
   * 其它消息」。没有这个入口，用户得自己选中、复制、记住，切回定位面板再粘贴。
   * 只在 Kafka 侧传：AMQP 没有 key 的顺序扫描语义。
   */
  onLocateKey?: (key: string) => void;
}

/** 定位面板的入参。 */
export interface MessageLocatePanelProps {
  connectionId: string;
  target: string;
  onSelect: (message: MessageSummary) => void;
  /**
   * 从消息详情带进来的 key。变化时把 key 填进表单并**自动开扫**：
   * 用户点的是「继续找」，不是「帮我把字填好，再点一次定位」。
   * 现场已经填好的其它条件（比如时间区间）保留 —— 见 `withFallbackKey`。
   */
  initialKey?: string | null;
}

/** `locateMessages` 的返回：一页命中 + 游标 + 这一轮的扫描代价。 */
export type MessageLocateResult = MessageSearch;

/** 消息列表的入参。 */
export interface MessageTableProps {
  connectionId: string;
  target: string;
  /** 只看某个分区（仅 Kafka）；不传表示全部分区。 */
  partition?: number;
  /** 选中一行。回传整条摘要，RabbitMQ 的 payload 就在里面，详情无需再请求。 */
  onSelect: (message: MessageSummary) => void;
  /** 是否显示 RabbitMQ 的消息处置入口（重投 / 移入死信）。 */
  canDispose?: boolean;
  /** 是否显示 Kafka 的重发入口。 */
  canResend?: boolean;
}

/** 处置弹窗的入参。 */
export interface MessageDisposalProps {
  connectionId: string;
  message: MessageSummary;
  /** 重投到别的交换机，或交给队列声明的死信交换机。 */
  action: "redeliver" | "deadLetter";
  onClose: () => void;
  /**
   * 拓扑里确切的交换机名。解析失败时传 `null`，目标交换机退回自由输入 ——
   * 这时候如果还硬做完备性校验，第一个被弹回去的就是用户真正想填的那个名字。
   */
  exchangeNames: string[] | null;
  /** 同上：全局去重后的 routing key。 */
  routingKeys: string[] | null;
}

/** 批量处置弹窗的入参。 */
export interface MessageBatchDisposalProps {
  connectionId: string;
  /** 选中的消息，顺序即回报顺序。 */
  messages: MessageSummary[];
  action: "redeliver" | "deadLetter";
  onClose: () => void;
  /** 有消息真的被处置成功时回调，让列表把这几行从选中集里摘掉。 */
  onDisposed: (messageIds: string[]) => void;
  /** 拓扑里确切的交换机名；`null` 表示没读到，目标交换机退回自由输入。 */
  exchangeNames: string[] | null;
  /** 同上：全局去重后的 routing key。 */
  routingKeys: string[] | null;
}

/** 消息重发弹窗的入参。 */
export interface MessageResendProps {
  connectionId: string;
  message: MessageSummary;
  onClose: () => void;
  /** 当前 topic 列表；`null` 表示还没读到或读失败，此时允许手填。 */
  topicNames: string[] | null;
}
