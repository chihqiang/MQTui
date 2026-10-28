/**
 * 成员分区归属，与 `src-tauri/src/domain/group_assignment.rs` 一一对应。
 *
 * 三种「读不到」在界面上必须分开说，混成一句「暂无」就是把人往错方向送。
 */
export interface AssignedPartition {
  topic: string;
  partition: number;
}

/** 一次分配的解析结论。 */
export type AssignmentState = "assigned" | "empty" | "broken";

export interface MemberAssignment {
  memberId: string;
  /** 成员负责的分区，后端已排序去重。 */
  partitions: AssignedPartition[];
  state: AssignmentState;
  /** 解析失败时的原因。 */
  problem?: string;
}

export interface GroupAssignment {
  byMember: MemberAssignment[];
  /** 需要用户知道的事实：读不懂、重复归属、协议不适用。 */
  notes?: string[];
}
