/**
 * 拓扑图坐标与交互规则的校验。
 *
 * 后端给的是「谁在第几层、第几行」，这里算的是像素与高亮。
 * 错的后果都是同一类：图上看起来像那么回事，结论却是错的。
 */

// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import type { GraphNode, TopologyGraph } from "../types/topology-graph.ts";
import {
  NODE_GAP_X,
  NODE_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  edgeLines,
  highlightOf,
  layoutGraph,
  matchNodes,
  nodeTitle,
} from "./topology-graph.ts";

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "e:orders",
    kind: "exchange",
    name: "orders",
    layer: 0,
    row: 0,
    ...overrides,
  };
}

function graph(nodes: GraphNode[], edges: TopologyGraph["edges"] = []): TopologyGraph {
  return { nodes, edges, layers: 1, omitted: 0 };
}

test("坐标按层与层内序号排开", () => {
  const layout = layoutGraph(
    graph([
      node({ id: "e:a", name: "a", layer: 0, row: 0 }),
      node({ id: "q:b", kind: "queue", name: "b", layer: 1, row: 1 }),
    ]),
  );
  const [first, second] = layout.boxes;
  assert.equal(first.x, 0);
  assert.equal(first.y, 0);
  assert.equal(second.x, NODE_GAP_X);
  assert.equal(second.y, NODE_HEIGHT + NODE_GAP_Y);
  // 画布尺寸必须包住最后一个节点，否则最后一列会被裁掉。
  assert.equal(layout.width, NODE_GAP_X + NODE_WIDTH);
  assert.equal(layout.height, NODE_HEIGHT + NODE_GAP_Y + NODE_HEIGHT);
});

test("空拓扑不产生画布", () => {
  const layout = layoutGraph(graph([]));
  assert.deepEqual(layout, { boxes: [], width: 0, height: 0 });
});

test("连线端点落在节点右侧与左侧中点", () => {
  const layout = layoutGraph(
    graph([
      node({ id: "e:a", name: "a", layer: 0, row: 0 }),
      node({ id: "q:a", kind: "queue", name: "a", layer: 1, row: 0 }),
    ]),
  );
  const lines = edgeLines([{ from: "e:a", to: "q:a", routingKey: "a" }], layout.boxes);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].x1, NODE_WIDTH);
  assert.equal(lines[0].y1, NODE_HEIGHT / 2);
  assert.equal(lines[0].x2, NODE_GAP_X);
  assert.equal(lines[0].y2, NODE_HEIGHT / 2);
});

test("端点缺失的连线被丢掉", () => {
  // 一条找不到端点的线画出来是悬空的，比没有线更让人费解。
  const layout = layoutGraph(graph([node({ id: "e:a", name: "a" })]));
  const lines = edgeLines([{ from: "e:a", to: "q:missing", routingKey: "" }], layout.boxes);
  assert.equal(lines.length, 0);
});

test("高亮只覆盖直接上下游", () => {
  const edges = [
    { from: "e:a", to: "e:b", routingKey: "" },
    { from: "e:b", to: "q:c", routingKey: "c" },
  ];
  const highlight = highlightOf("e:b", edges);
  assert.deepEqual([...(highlight?.nodes ?? [])].sort(), ["e:a", "e:b", "q:c"]);
  assert.deepEqual([...(highlight?.edges ?? [])], [0, 1]);

  // 跳两跳的节点不在高亮里：拓扑链可能有七八跳，全亮等于全不亮。
  const onlyFirst = highlightOf("e:a", edges);
  assert.deepEqual([...(onlyFirst?.nodes ?? [])].sort(), ["e:a", "e:b"]);
});

test("没有选中时不产生高亮", () => {
  assert.equal(highlightOf(null, []), null);
});

test("按名称与 routing key 过滤", () => {
  const target = graph(
    [
      node({ id: "e:orders", name: "orders", layer: 0 }),
      node({ id: "q:audit", kind: "queue", name: "audit", layer: 1 }),
    ],
    [{ from: "e:orders", to: "q:audit", routingKey: "order.created" }],
  );

  // 命中名称与 routing key 的并集：`order` 既在交换机名里，也在 `order.created` 里，
  // 所以整条边都被留下。只看名称会漏掉「名字没匹配、但 key 匹配」的排查场景。
  const byName = matchNodes(target, "order");
  assert.deepEqual([...(byName ?? [])].sort(), ["e:orders", "q:audit"]);

  // 只命中一个节点名：`audit` 不在 routing key 里，不该把交换机一起点亮。
  const onlyQueue = matchNodes(target, "audit");
  assert.deepEqual([...(onlyQueue ?? [])], ["q:audit"]);

  // 命中 routing key：连线的两端都留下，否则线会指向被过滤掉的框。
  const byKey = matchNodes(target, "created");
  assert.deepEqual([...(byKey ?? [])].sort(), ["e:orders", "q:audit"]);

  // 空关键字等于不过滤。
  assert.equal(matchNodes(target, "  "), null);
});

test("默认交换机显示成占位文案", () => {
  assert.equal(nodeTitle(node({ name: "" }), "(默认交换机)"), "(默认交换机)");
  assert.equal(nodeTitle(node({ name: "orders" }), "(默认交换机)"), "orders");
});
