/**
 * 批量设置保留时长：选什么 → 提交什么 → 确认框里怎么说。
 *
 * 这一层存在的理由和 `topic-config.ts` 一样，只是把「多选之后最常见的那个动作」
 * 从配置表里单独拎出来：改保留时长是唯一一个每个主题都常用、又常常要一次改一批的项。
 *
 * 有一点必须记住 —— `retention.ms = -1` 在 Kafka 里表示「永不过期」，而空串表示
 * 「删掉覆盖项、回落到 broker 默认」。两个都很容易被当成「不填就不改」，
 * 所以这里把「改什么」和「清空」拆成显式的两种意图，输入框里不接受空串。
 */

import type { ConfigChange } from "../types/topic-config.ts";

/** 保留时长的配置项名。 */
export const RETENTION_KEY = "retention.ms";

/** 毫秒常量：手打 604800000 那种数字最容易多一个零。 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 常用档位。`-1` 单独摆出来，因为它不是「时长」而是「不删」。 */
export const RETENTION_PRESETS: { label: string; ms: number; hint: string }[] = [
  { label: "1 小时", ms: HOUR, hint: "排查短时故障" },
  { label: "6 小时", ms: 6 * HOUR, hint: "" },
  { label: "1 天", ms: DAY, hint: "" },
  { label: "7 天", ms: 7 * DAY, hint: "大多数生产主题的默认档" },
  { label: "30 天", ms: 30 * DAY, hint: "" },
  { label: "永久", ms: -1, hint: "retention.ms = -1，永不因时长删除" },
];

/** 提交批量保留时长的动作：设成某个值，或删掉覆盖项回落到 broker 默认。 */
export type RetentionAction = { kind: "set"; ms: number } | { kind: "clear" };

export interface RetentionInput {
  action: RetentionAction;
  /** 用户手填的毫秒数；`action.kind === "set"` 且有值时优先于档位。 */
  custom: string;
}

/**
 * 解析成可提交的毫秒数。
 *
 * 返回 `null` 表示「不能提交」，调用方要拦下并说明原因。空串不当作「不改」——
 * 用户点开这个弹窗就是想来改点什么的，静默什么都不做是最差的结果。
 *
 * 只接受整数毫秒，且不许是 0：kafka 里 0 毫秒意味着「消息一写入就被删除」，
 * 这不是一个能顺手点到的操作，真要这么干应该去配置项编辑器里逐项确认。
 */
export function parseRetentionMs(input: RetentionInput): number | null {
  const raw = input.custom.trim();
  if (raw === "") return input.action.kind === "set" ? input.action.ms : null;
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) return null;
  if (value === 0) return null;
  if (value < -1) return null;
  return value;
}

/** 不能提交时的一句话原因；能提交时返回 `null`。 */
export function retentionIssue(input: RetentionInput): string | null {
  const raw = input.custom.trim();
  if (raw === "" && input.action.kind === "clear") return null;
  if (raw === "") {
    return input.action.kind === "set" ? null : "先选一个保留时长，或选「恢复默认」";
  }
  if (!/^-?\d+$/.test(raw)) return "只能填整数毫秒，例如 604800000";
  const ms = parseRetentionMs(input);
  if (ms === null) return "只支持 -1（永不过期）或不小于 1 的毫秒数；0 会让消息立刻被删，请去配置项编辑器里逐项确认";
  return null;
}

/** 把选择结果转成后端认的 `ConfigChange` 列表；`targets` 为空表示没有可提交的东西。 */
export function retentionChanges(
  targets: readonly string[],
  input: RetentionInput,
): ConfigChange[] {
  if (!targets.length) return [];
  const ms = parseRetentionMs(input);
  if (ms === null) return [];
  return targets.map(() => ({ key: RETENTION_KEY, value: String(ms) }));
}

/** 人话形式，用于确认框和提示：「7 天」比「604800000」更容易核对。 */
export function describeRetention(ms: number): string {
  if (ms === -1) return "永久（-1）";
  if (ms % DAY === 0) return `${ms / DAY} 天`;
  if (ms % HOUR === 0) return `${ms / HOUR} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  if (ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms} 毫秒`;
}

/**
 * 确认框里的那几行字。
 *
 * 一遍能读完的顺序：先说要动几个主题（含内部主题会被跳过这件事），
 * 再说改成什么，最后说不可回退的后果。少了任何一行，用户都得靠猜。
 */
export function describeRetentionPlan({
  targets,
  input,
  skipped = [],
}: {
  targets: readonly string[];
  input: RetentionInput;
  skipped?: readonly string[];
}): string[] {
  const lines: string[] = [];
  const ms = parseRetentionMs(input);
  lines.push(
    ms === null
      ? `将修改 ${targets.length} 个主题的保留时长`
      : `将把 ${targets.length} 个主题的 ${RETENTION_KEY} 设为 ${describeRetention(ms)}（${ms}）`,
  );
  if (input.action.kind === "clear" && input.custom.trim() === "") {
    lines.push("选中的是「恢复默认」：提交会删除覆盖项，改用 broker 默认值");
  }
  if (skipped.length) {
    lines.push(`内部主题不参与批量修改，已跳过：${skipped.join("、")}`);
  }
  lines.push("每个主题单独提交，逐个显示结果；中途失败不会回滚已经改好的那些");
  return lines;
}

/**
 * 结果汇总：「改了哪些、哪些没改成」。
 *
 * 批量操作最怕的是一句「完成」——总共 8 个主题，2 个失败，用户不会再去点一遍单个的。
 */
export function summarizeRetention(
  results: readonly { topic: string; ok: boolean; detail: string }[],
): { ok: number; failed: number; text: string } {
  const ok = results.filter((item) => item.ok).length;
  const failures = results.filter((item) => !item.ok);
  if (!failures.length) return { ok, failed: 0, text: `已更新 ${ok} 个主题的保留时长` };
  return {
    ok,
    failed: failures.length,
    text: `${ok} 个已更新，${failures.length} 个失败：${failures
      .map((item) => `${item.topic}（${item.detail}）`)
      .join("；")}`,
  };
}
