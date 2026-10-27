/** 与 `src-tauri/src/domain/group_block.rs` 一一对应的领域类型。 */

/** 一个卡住的分区。 */
export interface StuckPartition {
  topic: string;
  partition: number;
  /** 该分区剩余滞后量。 */
  lag: number;
  /** 被分配到这个分区的成员（客户端标识）；拿不到时缺省。 */
  members?: string[];
}

/** 队头阻塞的判定结果。 */
export interface BlockReport {
  blocked: boolean;
  headline: string;
  detail: string;
  /** 卡住的分区。 */
  stuck: StuckPartition[];
  /** 整组在窗口内一条都没动：不是阻塞，是没流量或全部挂着。 */
  idle: boolean;
  /** 位点回退的分区（`topic-partition`），它们的位移不能当依据。 */
  regressed: string[];
}

/** 队头阻塞采样的可选间隔，与后端 `normalize_window` 的范围一致。 */
export const BLOCK_WINDOWS: { label: string; ms: number }[] = [
  { label: "5 秒", ms: 5_000 },
  { label: "10 秒", ms: 10_000 },
  { label: "30 秒", ms: 30_000 },
  { label: "60 秒", ms: 60_000 },
];

/** 默认采样间隔。判「有没有动」比判「动得多快」宽容，所以比趋势采样长。 */
export const BLOCK_DEFAULT_WINDOW_MS = 10_000;
