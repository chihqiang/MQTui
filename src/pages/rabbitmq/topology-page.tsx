import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { Button, Card, CardBody, CardHeader, Empty, ErrorState, GraphSkeleton } from "@/components/ui";
import { FilterBar, GraphBoard, NavigateButton, NeighbourTable } from "@/components/broker";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useTopologyGraph } from "@/hooks/use-broker-data";
import { messagesPath } from "@/lib/actions";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgeLines,
  emptyEdgeHint,
  highlightOf,
  layoutGraph,
  matchNodes,
  neighbourRows,
  nodeTitle,
  nodeTone,
  subtitleOf,
} from "@/lib/topology-graph";
import { DEFAULT_EXCHANGE_LABEL } from "@/types";
import type { TopologyGraph } from "@/types";

/**
 * RabbitMQ 拓扑图。
 *
 * 与「路由估算」的分工：那边给结论（谁会收到、哪个是死路），这边给结构
 * （谁连着谁）。排查时先在这里看清形状，再去路由页确认可达性。
 *
 * 勾选「只看选中的上下游」而不是「过滤掉其它节点」：拓扑的意义在连线，
 * 把节点删掉之后剩下的线会指向不存在的框。
 */
export function TopologyPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useTopologyGraph(connectionId, true);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const layout = useMemo(() => (data ? layoutGraph(data) : null), [data]);
  const matched = useMemo(() => (data ? matchNodes(data, keyword) : null), [data, keyword]);
  const highlight = useMemo(
    () => (data ? highlightOf(selected, data.edges) : null),
    [data, selected],
  );

  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取拓扑", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading) return <GraphSkeleton label="正在读取拓扑…" />;
  if (!data) return <Empty title="暂无拓扑数据" />;
  if (!data.nodes.length) {
    return (
      <Empty
        title="没有拓扑可画"
        description="拓扑图依赖 RabbitMQ 管理插件（15672 端口），请检查连接配置中的管理 API 地址"
      />
    );
  }

  const boxes = layout?.boxes ?? [];
  const lines = edgeLines(data.edges, boxes).map((line, index) => ({
    id: `${line.edge.from}->${line.edge.to}:${line.edge.routingKey}`,
    ends: [line.edge.from, line.edge.to] as [string, string],
    x1: line.x1,
    y1: line.y1,
    x2: line.x2,
    y2: line.y2,
    labelX: line.labelX,
    labelY: line.labelY,
    label: line.edge.routingKey,
    highlighted: Boolean(highlight?.edges.has(index)),
  }));

  return (
    <PageBody>
      <PageHeader title="拓扑图" description="交换机与队列的分层连线；节点尺寸只表达类型，不混流量" />

      <PageToolbar
        hint={
          <>
            {formatNumber(data.nodes.length)} 个节点 · {formatNumber(data.edges.length)} 条绑定 ·{" "}
            {data.layers} 层
          </>
        }
        actions={
          selected ? (
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              取消选中
            </Button>
          ) : undefined
        }
      >
        <FilterBar
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按名称 / routing key 过滤"
          ariaLabel="过滤拓扑"
        />
      </PageToolbar>

      {data.omitted ? (
        <p className="text-(length:--text-app-body) text-amber-700">
          拓扑规模超过绘图上限，还有 {formatNumber(data.omitted)} 个节点没画出来。
          这一页回答「结构长什么样」，全量数据请看「交换机」页。
        </p>
      ) : null}

      <GraphBoard
        nodes={boxes.map((box) => ({
          id: box.node.id,
          title: nodeTitle(box.node, DEFAULT_EXCHANGE_LABEL),
          subtitle: subtitleOf(box.node),
          x: box.x,
          y: box.y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          tone: nodeTone(box.node),
          dimmed:
            (matched !== null && !matched.has(box.node.id)) ||
            (highlight !== null && !highlight.nodes.has(box.node.id)),
        }))}
        lines={lines}
        width={(layout?.width ?? 0) + 24}
        height={(layout?.height ?? 0) + 24}
        onSelect={(id) => setSelected((current) => (current === id ? null : id))}
      />

      {selected ? (
        <SelectionDetail graph={data} id={selected} connectionId={connectionId} />
      ) : null}
    </PageBody>
  );
}

/** 选中节点的上下游明细：图上看不清的是 routing key，这里逐条列出来。 */
function SelectionDetail({
  graph,
  id,
  connectionId,
}: {
  graph: TopologyGraph;
  id: string;
  connectionId: string | undefined;
}) {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) return null;
  const rows = neighbourRows(graph, id, DEFAULT_EXCHANGE_LABEL);

  return (
    <Card className="shrink-0">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono text-(length:--text-app-body) text-slate-800">
              {nodeTitle(node, DEFAULT_EXCHANGE_LABEL)}
            </span>
            <span className="text-(length:--text-app-meta) text-slate-500">
              上游 {rows.filter((row) => row.direction === "in").length} · 下游{" "}
              {rows.filter((row) => row.direction === "out").length}
            </span>
          </span>
        }
        extra={
          node.kind === "queue" ? (
            <NavigateButton
              size="xs"
              variant="secondary"
              to={messagesPath(connectionId, node.name)}
            >
              查看消息
            </NavigateButton>
          ) : null
        }
      />
      <CardBody className="max-h-48 overflow-auto p-0 text-(length:--text-app-body)">
        <NeighbourTable rows={rows} empty={emptyEdgeHint(node)} />
      </CardBody>
    </Card>
  );
}
