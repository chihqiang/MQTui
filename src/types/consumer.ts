/** 与 `src-tauri/src/domain/consumer.rs` 一一对应的领域类型。 */

/** 消费组概况，对应列表中的一行。 */
export interface ConsumerGroupInfo {
  name: string;
  /** Stable / Empty / Dead / PreparingRebalance 等，服务端原样返回。 */
  state: string;
  /** 组成员数。 */
  members: number;
  /** 组内滞后总量；成员不在线时服务端算不出，缺省。 */
  totalLag?: number;
}

/** 消费组内的一个成员。 */
export interface ConsumerGroupMember {
  memberId?: string;
  clientId?: string;
  clientHost?: string;
}

/** 消费组在某个分区上的进度。 */
export interface ConsumerGroupOffset {
  topic: string;
  partition: number;
  /** 已提交位点，未提交时缺省。 */
  offset?: number;
  /** 分区末尾位点。 */
  high: number;
  lag: number;
}

export interface ConsumerGroupDetail {
  group: ConsumerGroupInfo;
  members: ConsumerGroupMember[];
  offsets: ConsumerGroupOffset[];
}

/** 消费组分页结果。 */
export interface ConsumerGroupPage {
  items: ConsumerGroupInfo[];
  hasMore: boolean;
  /** 下一页游标，前端原样回传。 */
  cursor?: string;
}
