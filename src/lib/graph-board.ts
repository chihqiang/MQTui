/**
 * 画布数据的公共拼装：把「布局 + 高亮 + 过滤」变成一张好画的节点表。
 *
 * 拓扑图与消费链路图共用这一层。坐标仍由各自的 `layout*` 算，这里只做
 * 「这个节点该不该压暗、这条线该不该亮」这类两种图完全一致的判断 ——
 * 它们以前各写一遍，于是同一块画布在两页上的压暗规则并不一样。
 */

import type { LinkBox, LinkLine } from "./consumer-graph.ts";

export interface BoardNodeInput {
  id: string;
  title: string;
  subtitle?: string;
  hint?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: string;
}

export interface BoardLineInput {
  id: string;
  ends: [string, string];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX?: number;
  labelY?: number;
  label?: string;
  dashed?: boolean;
  highlighted?: boolean;
}

/** 是否该压暗：被关键字过滤掉，或不在当前高亮的子图里。 */
export function isDimmed(
  id: string,
  matched: Set<string> | null,
  highlight: { nodes: Set<string> } | null,
): boolean {
  if (matched !== null && !matched.has(id)) return true;
  if (highlight !== null && !highlight.nodes.has(id)) return true;
  return false;
}

/** 消费链路图的布局直接就是画布节点（配色与文案由页面给）。 */
export function boxesToLines(lines: readonly LinkLine[], highlighted: Set<number>): BoardLineInput[] {
  return lines.map((line, index) => ({
    id: `${line.edge.from}->${line.edge.to}:${line.edge.kind}:${line.edge.label}`,
    ends: [line.edge.from, line.edge.to],
    x1: line.x1,
    y1: line.y1,
    x2: line.x2,
    y2: line.y2,
    labelX: line.labelX,
    labelY: line.labelY,
    // 消费边不画 routing key 标签：AMQP 的消费关系没有 routing key。
    label: line.edge.kind === "binding" ? line.edge.label : undefined,
    dashed: line.edge.kind === "consume",
    highlighted: highlighted.has(index),
  }));
}

/** 消费链路图的节点表。 */
export function boxesToNodes(
  boxes: readonly LinkBox[],
  options: {
    titleOf: (box: LinkBox) => string;
    toneOf: (box: LinkBox) => string;
    matched: Set<string> | null;
    highlight: { nodes: Set<string> } | null;
  },
): BoardNodeInput[] {
  return boxes.map((box) => ({
    id: box.node.id,
    title: options.titleOf(box),
    subtitle: box.node.subtitle,
    hint: `${options.titleOf(box)}${box.node.subtitle ? ` · ${box.node.subtitle}` : ""}`,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    tone: options.toneOf(box),
    dimmed: isDimmed(box.node.id, options.matched, options.highlight),
  }));
}
