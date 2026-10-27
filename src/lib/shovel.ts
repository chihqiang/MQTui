/**
 * 铲子运行态的判读：纯函数，不发请求。
 *
 * 后端已经把配置与运行态配好对，并给出了 `problem`。这里只负责标签与文案；
 * `needsAttention` / `stateLabel` 必须与 `src-tauri/src/domain/shovel.rs` 同口径，
 * 改一边记得改另一边。
 */

import type { ShovelRow, ShovelSnapshot, ShovelState } from "../types/shovel.ts";
import type { Tone } from "../types/tone.ts";

const STATE_LABELS: Record<ShovelState, string> = {
  running: "运行中",
  starting: "启动中",
  terminated: "已停止",
};

/** 状态的中文名。没有运行态时不能报「已停止」——那是把「不知道」说成了结论。 */
export function stateLabel(row: ShovelRow): string {
  if (!row.runtime) return "无运行态";
  return STATE_LABELS[row.runtime.state];
}

/**
 * 状态色调。
 *
 * `terminated` 用 `danger`：它不会自己回来，消息就停在源端。
 * `starting` 用 `warning` 而不是 `neutral`：既不是好事也不是故障，唯一确定的是
 * 「现在还别下结论」。
 */
export function stateTone(row: ShovelRow): Tone {
  if (!row.runtime) return "neutral";
  switch (row.runtime.state) {
    case "running":
      return "success";
    case "starting":
      return "warning";
    case "terminated":
      return "danger";
  }
}

/** 这条铲子值不值得停下来看一眼。与后端 `ShovelRow::needs_attention` 同口径。 */
export function needsAttention(row: ShovelRow): boolean {
  return row.problem.trim().length > 0 || row.runtime?.state === "terminated";
}

/** 需要关注的行数。 */
export function attentionCount(snapshot: ShovelSnapshot): number {
  return snapshot.rows.filter(needsAttention).length;
}

/** 搬运条数。`0` 值得单说：配置在、状态在，却一条没搬过。 */
export function transferredText(row: ShovelRow): string {
  const count = row.runtime?.messagesTransferred;
  if (count === undefined) return "—";
  if (count === 0) return "一条都没搬过";
  return `${count.toLocaleString("zh-CN")} 条`;
}

/**
 * 「停一条铲子」到底会发生什么。
 *
 * 管理 API 没有 stop 端点，唯一的写操作是删运行态，而动态 / 静态两种铲子的后果
 * 完全不同。把这句话写进界面，比给个按钮再附一段免责声明要诚实。
 */
export function stopHint(row: ShovelRow): string {
  if (!row.runtime) {
    return "没有运行态，就没有可停的东西；先确认 shovel 插件已启用、这条配置被加载";
  }
  return row.runtime.kind === "dynamic"
    ? "动态铲子（运行中创建的）：删掉后立刻停止，配置本来就不存在，不会自己回来"
    : "静态铲子（参数里声明的）：停止要删配置或停用 shovel 插件；只删运行态，节点重启后它会照配置再起来";
}

/**
 * 顶部结论句。
 *
 * 三种「没什么好看」要分开说，否则会读成同一个结论：读不到运行态、
 * 一条铲子都没有、全都正常。
 */
export function summarize(snapshot: ShovelSnapshot): string {
  if (snapshot.rows.length === 0) {
    return snapshot.runtimeError ? "读不到铲子运行态" : "这个 vhost 没有铲子";
  }
  const attention = attentionCount(snapshot);
  if (attention > 0) return `${attention} 条需要看一眼`;
  return snapshot.runtimeError ? "配置都在，但看不到运行态" : "全部正常";
}
