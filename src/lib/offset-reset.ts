/**
 * 消费组位点重置的展示逻辑。
 *
 * 规则全在后端 `domain/offset_reset.rs`（先算对照、再判定能否执行），
 * 这里只负责两件后端不该管的事：
 *
 * 1. **把 delta 说成人话**：`-2000` 这种数字没人能在 0.3 秒内读懂是「重放」还是「跳过」；
 * 2. **确认文案里必须出现后果的数字**。位点重置不可撤销，
 *    只写「确定要重置吗」等于什么都没说。
 */

import type { ResetPlan, ResetStep } from "@/types";
import type { Tone } from "@/types/tone";

/** 单个分区的改动描述。 */
export function describeStep(step: ResetStep): string {
  if (!step.changed) return "无变化";
  if (step.delta > 0) return `重放 ${step.delta} 条`;
  return `跳过 ${-step.delta} 条`;
}

/** 分区改动的影响程度：重放比跳过更要紧（下游会收到重复消息）。 */
export function stepTone(step: ResetStep): Tone {
  if (!step.changed) return "neutral";
  return step.delta > 0 ? "warning" : "danger";
}

/** 整个计划的影响程度。 */
export function planTone(plan: ResetPlan): Tone {
  if (plan.blockers.length > 0) return "danger";
  if (plan.replay > 0) return "warning";
  if (plan.skip > 0) return "danger";
  return "neutral";
}

/** 一句话影响描述，用在按钮上方。 */
export function describeImpact(plan: ResetPlan): string {
  const parts: string[] = [];
  if (plan.replay > 0) parts.push(`重放 ${plan.replay} 条历史消息`);
  if (plan.skip > 0) parts.push(`跳过 ${plan.skip} 条消息`);
  if (parts.length === 0) return "位点没有变化";
  return `${parts.join("，")}；该操作不可撤销`;
}

/**
 * 确认输入的目标文案。
 *
 * 与消费者断开那里用的是同一个模式：手打队列名 / 消费组名才能执行。
 * 「点两下确定」挡不住误操作，打字能。
 */
export function confirmToken(group: string): string {
  return `reset ${group}`;
}

/** 用户输入是否满足确认条件。 */
export function confirmSatisfied(input: string, group: string): boolean {
  return input.trim() === confirmToken(group);
}

/** 需要提交的分区数。 */
export function changedCount(plan: ResetPlan): number {
  return plan.steps.filter((step) => step.changed).length;
}

/**
 * 计划是否可以提交。
 *
 * 三个条件缺一不可：没有阻断原因、确实有分区变化、手打了确认串。
 * 第三项是刻意加的——「点两下确定」挡不住误操作，打字能。
 */
export function canSubmit(plan: ResetPlan, input: string, group: string): boolean {
  return plan.blockers.length === 0 && changedCount(plan) > 0 && confirmSatisfied(input, group);
}
