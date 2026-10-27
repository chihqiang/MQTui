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

/** 消费组列表的列：只放组级信息，滞后量留给详情页按需算。 */
export const GROUP_COLUMNS = [
  { key: "name", label: "组名" },
  { key: "state", label: "状态", width: "w-28" },
  { key: "members", label: "成员", width: "w-20", align: "right" },
  { key: "lag", label: "滞后", width: "w-28", align: "right" },
  { key: "actions", label: "操作", width: "w-20", align: "right" },
] as const;

/** 组内分区进度的列。 */
export const OFFSET_COLUMNS = [
  { key: "topic", label: "topic" },
  { key: "partition", label: "分区", width: "w-16", align: "right" },
  { key: "offset", label: "已提交", width: "w-28", align: "right" },
  { key: "high", label: "末尾", width: "w-28", align: "right" },
  { key: "lag", label: "滞后", width: "w-24", align: "right" },
] as const;
