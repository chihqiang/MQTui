/**
 * 一次操作的「后果」。
 *
 * 破坏性动作在确认框里先说清「会失去什么」，这句话由 `lib/actions.ts` 的
 * `describeAction` 生成 —— 文案归 lib，能被单测钉住；这里只放类型。
 */
export interface ActionImpactInput {
  /** 受影响的对象名（队列名 / 主题名 / 连接名）。 */
  target: string;
  /** 对象里还剩多少条消息；未上报时为 undefined，文案不能说成「0 条」。 */
  messages?: number;
  /** 有多少消费者正在收这批消息。 */
  consumers?: number;
  /** 这个动作是不是「连消息一起丢掉」。 */
  losesMessages: boolean;
}

/** 确认框需要的那句话：一句结论 + 需要点名核对的对象。 */
export interface ActionImpact {
  /** 一句话结论。「消失的是消息本身，不是索引」这种必须说透。 */
  summary: string;
  /** 不可撤销的动作置 true，确认框会额外染红并要求手打名称。 */
  irreversible: boolean;
}

/**
 * 消息页的入口路由片段。
 *
 * 「查看某个 topic / 队列的消息」是全站出现最多的跳转（主题列表、分区行、
 * 交换机绑定、路由估算、两张图、队列列表都要用）。路径在这里定义一次，
 * 页面只管把名字交出去，拼接由 `lib/actions.ts` 负责。
 */
export const MESSAGES_PATH = "messages";
