/** 消费组位点重置接口，对应 `src-tauri/src/commands/reset.rs`。 */

import { call } from "./ipc";
import type { CommitOutcome, ResetPhase, ResetPlan, ResetTarget } from "@/types";

export const resetService = {
  /**
   * 预览重置计划（只读）。
   *
   * `offsets` 只在「精确位点」模式用；`timestamp` 只在「按时间」模式用。
   * 两个都传也没关系，后端只取当前 target 需要的那一个。
   */
  preview: (
    id: string,
    group: string,
    topic: string,
    target: ResetTarget,
    offsets?: [number, number][],
    timestamp?: number,
  ) =>
    call<ResetPlan>("preview_group_reset", {
      id,
      group,
      topic,
      target,
      offsets,
      timestamp,
    }),

  /**
   * 提交计划。
   *
   * 带上整份 `plan` 而不是「组 + 主题 + 目标」：从预览到确认之间消费者可能已经推进了位点，
   * 重新算一遍会让用户确认的后果与实际执行的后果不是同一件事。
   */
  commit: (id: string, group: string, topic: string, plan: ResetPlan) =>
    call<CommitOutcome>("commit_group_reset", { id, group, topic, plan }),

  /** 执行顺序说明。 */
  phases: (id: string, group: string) => call<ResetPhase[]>("reset_phases", { id, group }),
};
