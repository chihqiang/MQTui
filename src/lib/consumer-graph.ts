/**
 * 消费者连线图的坐标与交互规则。
 *
 * 后端已经定好每个节点在第几层、层内第几行（`domain/consumer_graph.rs`），
 * 这里只做「层 → 像素」。和 `lib/topology-graph.ts` 共用尺寸常量，
 * 两张图放在一起看时框的大小一致，切换页面不会有跳动感。
 *
 * 一个刻意的差异：连接节点比交换机 / 队列宽。连接名常常是
 * `orders-worker-7d9f4b-x2m1p` 这种带 hash 的 pod 名，168px 里只剩前半截，
 * 而「哪一半」往往正是区分副本的关键。
 */

import {
  NODE_GAP_X,
  NODE_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "./topology-graph.ts";
import type {
  ConsumerGraph,
  LinkEdge,
  LinkHealth,
  LinkNode,
} from "../types/consumer-graph.ts";

/**
 * 节点类型。这里就地判断而不从 `types/consumer-graph.ts` 引入 `kindOf`：
 * 那个模块是运行时导出，`node:test` 直接跑 `.ts` 时解析不了路径别名。
 * `id` 的前缀约定由后端固定（`e:` / `q:` / `c:`），一个 startsWith 足够。
 */
function kindOf(nodeId: string): LinkNode["kind"] {
  if (nodeId.startsWith("e:")) return "exchange";
  if (nodeId.startsWith("c:")) return "connection";
  return "queue";
}

/** 消费者连接节点的宽度。 */
export const CONNECTION_WIDTH = NODE_WIDTH + 56;

/** 一个节点的画布坐标（左上角）与宽度。 */
export interface LinkBox {
  node: LinkNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinkLayout {
  boxes: LinkBox[];
  width: number;
  height: number;
}

/** 节点宽度：按类型区分，见文件头的说明。 */
export function widthOf(node: LinkNode): number {
  return node.kind === "connection" ? CONNECTION_WIDTH : NODE_WIDTH;
}

export function layoutConsumerGraph(graph: ConsumerGraph): LinkLayout {
  if (!graph.nodes.length) {
    return { boxes: [], width: 0, height: 0 };
  }

  // 层与层之间按「最宽的节点 + 间距」推进，否则宽框会把下一层压住。
  const layerWidth = new Map<number, number>();
  for (const node of graph.nodes) {
    layerWidth.set(node.layer, Math.max(layerWidth.get(node.layer) ?? 0, widthOf(node)));
  }
  const layerX = new Map<number, number>();
  let cursor = 0;
  for (const layer of [...layerWidth.keys()].sort((a, b) => a - b)) {
    layerX.set(layer, cursor);
    cursor += (layerWidth.get(layer) ?? NODE_WIDTH) + NODE_GAP_X - NODE_WIDTH;
  }

  const boxes: LinkBox[] = graph.nodes.map((node) => ({
    node,
    x: layerX.get(node.layer) ?? 0,
    y: node.row * (NODE_HEIGHT + NODE_GAP_Y),
    width: widthOf(node),
    height: NODE_HEIGHT,
  }));

  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { boxes, width: maxX, height: maxY };
}

export interface LinkLine {
  edge: LinkEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
}

/**
 * 由坐标算出连线。端点缺失的边直接丢掉 —— 一条悬空的线比没有更让人费解。
 *
 * 消费边不画 routing key 标签：AMQP 的消费关系没有 routing key，
 * 那个位置只会显示一堆空标签，把图糊住。
 */
export function linkLines(edges: LinkEdge[], boxes: LinkBox[]): LinkLine[] {
  const index = new Map(boxes.map((box) => [box.node.id, box]));
  const lines: LinkLine[] = [];

  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
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
 * 高亮规则：一跳邻居。
 *
 * 这里比拓扑图多一条：选中**队列**时，把「同一连接消费的其它队列」也一并算上。
 * 排查时最常问的是「这个消费者把哪些队列的消息一起拿走了」，这在列表里
 * 要跨好几行才看得出来。
 */
export function highlightOf(
  selected: string | null,
  edges: LinkEdge[],
): { nodes: Set<string>; edges: Set<number> } | null {
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

  const kind = kindOf(selected);
  if (kind === "connection") {
    // 选中连接：它的上游队列已经在上面补齐了，不再展开第二跳。
    return { nodes, edges: picked };
  }

  // 选中队列时展开「经由同一连接牵连到的其它队列」。
  // 这是这张图存在的理由：一个消费者同时拿两个队列的消息，列表里要跨好几行才看得出来。
  //
  // 实现上先按 `to`（连接）建立反向索引再查，而不是每行都做一次 `edge.from === bridge`：
  // 后者在几百条边的图上要做 O(n²) 次字符串比较，结果一样但没必要。
  if (kind === "queue") {
    const byConnection = new Map<string, number[]>();
    edges.forEach((edge, index) => {
      if (kindOf(edge.to) !== "connection") return;
      const bucket = byConnection.get(edge.to) ?? [];
      bucket.push(index);
      byConnection.set(edge.to, bucket);
    });

    const connections = new Set<string>();
    edges.forEach((edge) => {
      if (edge.from === selected && kindOf(edge.to) === "connection") {
        connections.add(edge.to);
      }
    });

    for (const connection of connections) {
      for (const index of byConnection.get(connection) ?? []) {
        const edge = edges[index];
        if (edge.from === selected) continue;
        nodes.add(edge.from);
        picked.add(index);
      }
    }
  }

  return { nodes, edges: picked };
}

/** 关键字过滤：命中名称、副标题或相连的 routing key。 */
export function matchNodes(graph: ConsumerGraph, keyword: string): Set<string> | null {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return null;

  const hit = new Set<string>();
  for (const node of graph.nodes) {
    if (node.name.toLowerCase().includes(needle)) hit.add(node.id);
    if (node.subtitle?.toLowerCase().includes(needle)) hit.add(node.id);
  }
  for (const edge of graph.edges) {
    if (edge.label.toLowerCase().includes(needle)) {
      hit.add(edge.from);
      hit.add(edge.to);
    }
  }
  return hit;
}

/** 节点标题：默认交换机是空串，必须显示成一句人话。 */
export function nodeTitle(node: LinkNode, defaultExchangeLabel: string): string {
  if (node.kind === "exchange" && node.name === "") return defaultExchangeLabel;
  return node.name;
}

export interface HeaderStats {
  exchanges: number;
  queues: number;
  connections: number;
  /** 有异常的连接数（warn + idle）。 */
  troubled: number;
}

/** 页面顶部那行结论。数字全部来自图本身，不再单独请求。 */
export function headerStats(graph: ConsumerGraph): HeaderStats {
  const count = (kind: string) => graph.nodes.filter((node) => node.kind === kind).length;
  return {
    exchanges: count("exchange"),
    queues: count("queue"),
    connections: count("connection"),
    troubled: graph.nodes.filter(
      (node) => node.kind === "connection" && (node.health === "warn" || node.health === "idle"),
    ).length,
  };
}

/** 健康状态的人类读法。`healthy` 没有提示，返回 `null`。 */
export const HEALTH_LABEL: Record<LinkHealth, string | null> = {
  healthy: null,
  warn: "有消费者卡在预取上限",
  idle: "有消费者但一条消息都没领到",
};
