/**
 * 拓扑图的坐标计算与交互规则。
 *
 * 后端已经把「谁在第几层」算好了（`domain/topology_graph.rs`），这里只负责
 * 「第几层画在哪个像素」。布局逻辑放在渲染层之外的好处是：它可以直接跑
 * `node:test`，不必拉起 DOM 和 canvas。
 *
 * 三个刻意不做的事：
 *
 * 1. **不做力导向**。几百个节点的力导向图每帧都在动，用户没法把一个节点
 *    拖到视线中央再对着看。分层固定布局至少每次打开长得一样。
 * 2. **不按流量缩放节点**。节点大小只表达类型（交换机 / 队列），
 *    流量用颜色深浅和文字，混在几何尺寸里会让人误判「这个框大所以重要」。
 * 3. **不画曲线**。直线 + routing key 标签足以说清「谁连到谁」，
 *    曲线在长边上只会让人找到不端点。
 */

import type { GraphEdge, GraphNode, TopologyGraph } from "@/types";

/** 节点外框尺寸（像素）。与画布共用，避免两处写死。 */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 44;
/** 同层节点之间的纵向间距。 */
export const NODE_GAP_Y = 16;
/** 层与层之间的横向间距，留出 routing key 标签的位置。 */
export const NODE_GAP_X = 220;

/** 一个节点的画布坐标（左上角）。 */
export interface NodeBox {
  node: GraphNode;
  x: number;
  y: number;
}

/** 画布尺寸与全部节点坐标。 */
export interface GraphLayout {
  boxes: NodeBox[];
  width: number;
  height: number;
}

/**
 * 计算全部节点的坐标。
 *
 * 纵向按层内序号排（后端已按名称排序），横向按层号。层数很多时画布会很宽，
 * 这是分层的代价——横着滚比让节点互相压在一起好。
 */
export function layoutGraph(graph: TopologyGraph): GraphLayout {
  if (!graph.nodes.length) {
    return { boxes: [], width: 0, height: 0 };
  }

  const boxes: NodeBox[] = graph.nodes.map((node) => ({
    node,
    x: node.layer * NODE_GAP_X,
    y: node.row * (NODE_HEIGHT + NODE_GAP_Y),
  }));

  const maxX = Math.max(...boxes.map((box) => box.x));
  const maxY = Math.max(...boxes.map((box) => box.y));
  return {
    boxes,
    width: maxX + NODE_WIDTH,
    height: maxY + NODE_HEIGHT,
  };
}

/** 连线的两个端点：从源节点右边中点到目标节点左边中点。 */
export interface EdgeLine {
  edge: GraphEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 标签锚点，放在线中间。 */
  labelX: number;
  labelY: number;
}

/**
 * 由节点坐标算出连线。
 *
 * 端点缺失的边直接丢掉：后端已经过滤了被截断节点的边，但前端不该依赖这一点——
 * 一条找不到端点的线画出来是悬空的，比没有更让人费解。
 */
export function edgeLines(
  edges: GraphEdge[],
  boxes: NodeBox[],
): EdgeLine[] {
  const index = new Map(boxes.map((box) => [box.node.id, box]));
  const lines: EdgeLine[] = [];

  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;
    lines.push({
      edge,
      x1,
      y1,
      x2,
      y2,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 6,
    });
  }

  return lines;
}

/**
 * 高亮规则：选中一个节点时，只保留它的直接上游与下游。
 *
 * 不做「传递闭包」高亮。拓扑里一条链可能有七八跳，全亮等于全不亮；
 * 排查时人问的是「这一步连到哪」，一跳就够回答。
 */
export interface Highlight {
  nodes: Set<string>;
  edges: Set<number>;
}

export function highlightOf(
  selected: string | null,
  edges: GraphEdge[],
): Highlight | null {
  if (!selected) return null;
  const nodes = new Set<string>([selected]);
  const picked = new Set<number>();

  edges.forEach((edge, index) => {
    if (edge.from === selected || edge.to === selected) {
      nodes.add(edge.from);
      nodes.add(edge.to);
      picked.add(index);
    }
  });

  return { nodes, edges: picked };
}

/** 按名称过滤节点：命中名称或它的任意一条连线的 routing key。 */
export function matchNodes(graph: TopologyGraph, keyword: string): Set<string> | null {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return null;

  const hit = new Set<string>();
  for (const node of graph.nodes) {
    if (node.name.toLowerCase().includes(needle)) hit.add(node.id);
  }
  for (const edge of graph.edges) {
    if (edge.routingKey.toLowerCase().includes(needle)) {
      hit.add(edge.from);
      hit.add(edge.to);
    }
  }
  return hit;
}

/** 节点显示的标题：默认交换机是空串，不能显示成一片空白。 */
export function nodeTitle(node: GraphNode, defaultLabel: string): string {
  return node.name === "" ? defaultLabel : node.name;
}
