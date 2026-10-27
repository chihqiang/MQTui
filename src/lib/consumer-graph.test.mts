/**
 * 消费链路图坐标与交互规则的校验。
 *
 * 后端给「谁在第几层、第几行」，这里算像素与高亮。错的后果统一是：
 * 图看着像那么回事，但结论错了。所以重点盯三类：
 * 1. 宽节点不能把下一层压住；
 * 2. 端点缺失的线必须丢掉，不能悬空；
 * 3. 选中队列时要把「同一连接消费的其它队列」也点亮 —— 这是这张图存在的理由。
 */

import { expect, test } from "vitest";

import type { ConsumerGraph, LinkEdge, LinkNode } from "../types/consumer-graph.ts";
import {
  CONNECTION_WIDTH,
  HEALTH_LABEL,
  headerStats,
  highlightOf,
  layoutConsumerGraph,
  linkLines,
  matchNodes,
  nodeTitle,
  widthOf,
} from "./consumer-graph.ts";

function node(overrides: Partial<LinkNode> = {}): LinkNode {
  return {
    id: "q:orders",
    kind: "queue",
    name: "orders",
    layer: 1,
    row: 0,
    ...overrides,
  };
}

function graphOf(nodes: LinkNode[], edges: LinkEdge[] = []): ConsumerGraph {
  const layers = nodes.length ? Math.max(...nodes.map((item) => item.layer)) + 1 : 0;
  return {
    nodes,
    edges,
    layers,
    omitted: 0,
    queueCount: nodes.filter((item) => item.kind === "queue").length,
    connectionCount: nodes.filter((item) => item.kind === "connection").length,
  };
}

test("连接节点比交换机宽，避免 pod 名被截断", () => {
  const exchange = node({ id: "e:x", kind: "exchange", name: "x", layer: 0 });
  const connection = node({ id: "c:svc", kind: "connection", name: "svc", layer: 2 });
  expect(widthOf(connection) > widthOf(exchange)).toBeTruthy();
  expect(widthOf(connection)).toBe(CONNECTION_WIDTH);
});

test("层间距按该层最宽节点推进", () => {
  const nodes = [
    node({ id: "e:x", kind: "exchange", name: "x", layer: 0 }),
    node({ id: "q:orders", layer: 1 }),
    node({ id: "c:svc", kind: "connection", name: "svc", layer: 2 }),
  ];
  const layout = layoutConsumerGraph(graphOf(nodes));
  const at = (id: string) => layout.boxes.find((box) => box.node.id === id);
  // 第二层是连接层，宽出 56px；第三层的起点必须把这段宽度算进去。
  const gap = at("c:svc")!.x - (at("q:orders")!.x + at("q:orders")!.width);
  expect(gap > 0).toBeTruthy();
});

test("空图不产生负数画布", () => {
  const layout = layoutConsumerGraph(graphOf([]));
  expect(layout).toEqual({ boxes: [], width: 0, height: 0 });
});

test("端点缺失的边被丢弃", () => {
  const nodes = [node({ id: "q:orders" })];
  const lines = linkLines(
    [{ from: "q:orders", to: "c:ghost", kind: "consume", label: "" }],
    layoutConsumerGraph(graphOf(nodes)).boxes
  );
  // 悬空的线指向一个不存在的框，比没有更让人费解。
  expect(lines.length).toBe(0);
});

test("选中队列时点亮同一连接消费的其它队列", () => {
  const edges: LinkEdge[] = [
    { from: "q:orders", to: "c:svc-a", kind: "consume", label: "" },
    { from: "q:audit", to: "c:svc-a", kind: "consume", label: "" },
    { from: "q:other", to: "c:svc-b", kind: "consume", label: "" },
  ];
  const highlight = highlightOf("q:orders", edges);
  expect(highlight).toBeTruthy();
  if (!highlight) return;
  expect(highlight.nodes.has("c:svc-a")).toBeTruthy();
  // 关键：同一个消费者顺带拿走的那条队列也要亮。
  expect(highlight.nodes.has("q:audit")).toBeTruthy();
  expect(highlight.nodes.has("c:svc-b")).toBe(false);
  expect(highlight.nodes.has("q:other")).toBe(false);
});

test("选中连接只展开一跳", () => {
  const edges: LinkEdge[] = [
    { from: "q:orders", to: "c:svc-a", kind: "consume", label: "" },
    { from: "q:audit", to: "c:svc-a", kind: "consume", label: "" },
    { from: "e:fanout", to: "q:orders", kind: "binding", label: "" },
  ];
  const highlight = highlightOf("c:svc-a", edges);
  expect(highlight).toBeTruthy();
  if (!highlight) return;
  expect(highlight.nodes.has("q:orders")).toBeTruthy();
  expect(highlight.nodes.has("q:audit")).toBeTruthy();
  // 第二跳（fanout）不亮：拓扑里一条链七八跳，全亮等于全不亮。
  expect(highlight.nodes.has("e:fanout")).toBe(false);
});

test("未选中时不返回高亮", () => {
  expect(highlightOf(null, [])).toBe(null);
});

test("关键字命中副标题与 routing key", () => {
  const graph = graphOf(
    [
      node({ id: "c:svc-a", kind: "connection", name: "svc-a", layer: 2, subtitle: "用户 app" }),
      node({ id: "q:orders" }),
      node({ id: "e:fanout", kind: "exchange", name: "fanout", layer: 0 }),
    ],
    [{ from: "e:fanout", to: "q:orders", kind: "binding", label: "order.created" }]
  );
  expect([...(matchNodes(graph, "app") ?? [])]).toEqual(["c:svc-a"]);
  // 命中 routing key 时两头都要亮，否则线看起来是断的。
  const byKey = matchNodes(graph, "created");
  expect(byKey?.has("e:fanout") && byKey.has("q:orders")).toBeTruthy();
  expect(matchNodes(graph, "   ")).toBe(null);
});

test("默认交换机的空名称显示成占位文案", () => {
  const defaultExchange = node({ id: "e:", kind: "exchange", name: "", layer: 0 });
  expect(nodeTitle(defaultExchange, "(默认交换机)")).toBe("(默认交换机)");
  // 队列名不会是空串，不该被替换。
  expect(nodeTitle(node({ name: "orders" }), "(默认交换机)")).toBe("orders");
});

test("顶部统计只数连接节点的异常", () => {
  const graph = graphOf([
    node({ id: "e:x", kind: "exchange", name: "x", layer: 0 }),
    node({ id: "q:orders", layer: 1, health: "warn" }),
    node({ id: "c:a", kind: "connection", name: "a", layer: 2, health: "warn" }),
    node({ id: "c:b", kind: "connection", name: "b", layer: 2, health: "idle" }),
    node({ id: "c:c", kind: "connection", name: "c", layer: 2 }),
  ]);
  const stats = headerStats(graph);
  expect(stats.exchanges).toBe(1);
  expect(stats.queues).toBe(1);
  expect(stats.connections).toBe(3);
  // 队列上挂的健康字段不参与统计：结论只对连接下。
  expect(stats.troubled).toBe(2);
});

test("healthy 不给提示文案", () => {
  expect(HEALTH_LABEL.healthy).toBe(null);
  expect(HEALTH_LABEL.warn).toBeTruthy();
  expect(HEALTH_LABEL.idle).toBeTruthy();
});
