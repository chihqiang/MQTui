/**
 * 集群页的展示逻辑。
 *
 * 判读规则在后端（`domain/cluster_view.rs` / `node_stats.rs`），这里只做
 * 「把结论翻译成颜色和文案」以及两条后端不该管的展示规则：
 *
 * - 节点占比怎么显示：上限未知时必须写「未知」而不是 0%，
 *   否则用户会把「管理 API 没报上限」读成「内存很空」；
 * - 队列位置怎么读：空节点列表不是「没有数据」，是「当前不可用」。
 */

import type { AlertSeverity, ClusterNode, NodeRole, NodeStat, NodeVerdict, QueuePlacement } from "@/types";
import type { Tone } from "@/types/tone";

const ROLE_TONE: Record<NodeRole, Tone> = {
  member: "neutral",
  disc: "info",
  ram: "info",
  controller: "success",
  offline: "danger",
};

export const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  warn: "danger",
  info: "info",
};

/** 节点角色的色调。 */
export function roleTone(role: NodeRole): Tone {
  return ROLE_TONE[role];
}

/**
 * 状态的色调：运行中为绿，离线为红。
 *
 * 不按角色判断——controller 也可能不在运行，那时候红色比「绿色的控制节点」诚实得多。
 */
export function nodeTone(node: ClusterNode): Tone {
  return node.running ? "success" : "danger";
}

/** 内存占比文案。上限未知时返回 null，由调用方显示「未知」。 */
export function memRatioText(stat: NodeStat): string | null {
  if (stat.memLimit <= 0) return null;
  return `${Math.round((stat.memUsed / stat.memLimit) * 100)}%`;
}

/** 文件描述符占比。 */
export function fdRatioText(stat: NodeStat): string | null {
  if (stat.fdTotal <= 0) return null;
  return `${Math.round((stat.fdUsed / stat.fdTotal) * 100)}%`;
}

/**
 * 判断节点的展示色调。
 *
 * 顺序与后端 `verdict` 一致：离线 > 服务端告警 > 磁盘下限 > 内存偏紧 > 正常。
 * 前后端各写一份不是重复——后端给的是「结论」，这里给的是「颜色」，
 * 结论的措辞会变，颜色不会。
 */
export function statTone(stat: NodeStat): Tone {
  if (!stat.running) return "danger";
  if (stat.alarm) return "danger";
  if (stat.diskLimit > 0 && stat.diskFree < stat.diskLimit) return "danger";
  if (stat.memLimit > 0 && stat.memUsed / stat.memLimit >= 0.8) return "warning";
  return "success";
}

/** 队列位置的展示文案。 */
export function placementText(queue: QueuePlacement): string {
  return queue.nodes.length ? queue.nodes.join("、") : "未分配（当前不可用）";
}

/**
 * 队列的可用性结论。
 *
 * 单副本队列挂在唯一节点上，这个节点挂了队列就不可用——但这一点从
 * 「位置」这一列看不出来，必须显式给出来。
 */
export function placementRisk(queue: QueuePlacement): string | null {
  if (queue.nodes.length === 0) return "没有可用节点，队列当前不可用";
  if (queue.kind === "quorum" && queue.nodes.length === 1) {
    return "仲裁队列只剩一个成员：再掉一个节点就会失去多数派";
  }
  if (queue.kind !== "quorum" && !queue.exclusive && queue.nodes.length === 1) {
    return "单副本：所在节点故障时队列不可用";
  }
  return null;
}

/** 页面顶部的一句话总结。 */
export function describeCluster(nodes: ClusterNode[], alerts: number): string {
  if (!nodes.length) return "未获取到节点信息";
  const running = nodes.filter((node) => node.running).length;
  const head = `${running}/${nodes.length} 个节点在运行`;
  return alerts > 0 ? `${head}，${alerts} 条需要关注的结论` : `${head}，没有需要关注的结论`;
}

/** 结论的展示色调。 */
export function verdictTone(verdict: NodeVerdict): Tone {
  return verdict.attention ? "warning" : "success";
}
