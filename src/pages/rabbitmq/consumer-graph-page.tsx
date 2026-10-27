import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { Badge, Button, Empty, ErrorState, GraphSkeleton } from "@/components/ui";
import { FilterBar, GraphBoard, NavigateButton, NeighbourTable } from "@/components/broker";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useConsumerGraph } from "@/hooks/use-broker-data";
import { messagesPath } from "@/lib/actions";
import { boxesToLines, boxesToNodes } from "@/lib/graph-board";
import {
  HEALTH_LABEL,
  emptyEdgeHint,
  headerStats,
  highlightOf,
  kindLabelOf,
  layoutConsumerGraph,
  linkLines,
  matchNodes,
  neighbourRows,
  nodeTitle,
  nodeTone,
} from "@/lib/consumer-graph";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import { DEFAULT_EXCHANGE_LABEL } from "@/types";
import type { ConsumerGraph } from "@/types";

/**
 * RabbitMQ 消费链路图。
 *
 * 与另外两张图的分工：
 * - 「拓扑图」只画交换机 ↔ 队列，回答「消息走哪条路」；
 * - 「消费链路」把消费者连接也画进来，回答「消息最后被谁拿走」；
 * - 「路由估算」给结论（谁收得到、哪里是死路）。
 *
 * 连接节点按连接名聚合，一个服务几十个 channel 只占一个框 ——
 * 这正是前几轮我拒绝画「队列 → 消费者」星形图、而这一版敢画的原因。
 */
export function ConsumerGraphPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useConsumerGraph(connectionId, true);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const layout = useMemo(() => (data ? layoutConsumerGraph(data) : null), [data]);
  const lines = useMemo(
    () => (data && layout ? linkLines(data.edges, layout.boxes) : []),
    [data, layout],
  );
  const matched = useMemo(() => (data ? matchNodes(data, keyword) : null), [data, keyword]);
  const highlight = useMemo(
    () => (data ? highlightOf(selected, data.edges) : null),
    [data, selected],
  );

  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取消费链路", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  if (isLoading) return <GraphSkeleton label="正在读取消费链路…" />;
  if (!data) return <Empty title="暂无链路数据" />;
  if (!data.nodes.length) {
    return (
      <Empty
        title="没有消费链路可画"
        description="这一页依赖 RabbitMQ 管理插件（15672 端口）：请检查连接配置中的管理 API 地址，并确认队列上确实有消费者"
      />
    );
  }

  const stats = headerStats(data);

  return (
    <PageBody>
      <PageHeader title="消费链路" description="交换机 → 队列 → 消费者连接；消费者按连接聚合，扇形当场收敛" />

      <PageToolbar
        hint={
          <>
            {stats.exchanges} 交换机 · {stats.queues} 队列 · {stats.connections} 连接
            {stats.troubled ? (
              <span className="ml-2 text-amber-700">{stats.troubled} 条连接有异常</span>
            ) : null}
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
          placeholder="按交换机 / 队列 / 连接名过滤"
          ariaLabel="过滤消费链路"
        />
      </PageToolbar>

      {data.omitted ? (
        <p className="text-(length:--text-app-body) text-amber-700">
          连接数超过绘图上限，还有 {formatNumber(data.omitted)} 个消费者连接没画出来（保留的是消费者最多的那些）。
          完整的逐条明细请看「消费者」页。
        </p>
      ) : null}

      {stats.troubled ? (
        <p className="text-(length:--text-app-body) text-amber-700">
          {formatNumber(stats.troubled)} 条连接标黄或标灰：标黄是「预取已满，实际已不再收消息」，
          标灰是「连着但一条消息都没领到」。这两种都是队列只涨不消的常见成因。
        </p>
      ) : null}

      <GraphBoard
        nodes={boxesToNodes(layout?.boxes ?? [], {
          titleOf: (box) => nodeTitle(box.node, DEFAULT_EXCHANGE_LABEL),
          toneOf: (box) => nodeTone(box.node),
          matched,
          highlight,
        })}
        lines={boxesToLines(lines, highlight?.edges ?? new Set())}
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

/** 选中节点的上下游明细：图上看不清的是完整连接名与 routing key。 */
function SelectionDetail({
  graph,
  id,
  connectionId,
}: {
  graph: ConsumerGraph;
  id: string;
  connectionId: string | undefined;
}) {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) return null;
  const rows = neighbourRows(graph, id, DEFAULT_EXCHANGE_LABEL);
  const health = node.health ? HEALTH_LABEL[node.health] : null;

  return (
    <div className="shrink-0 rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
        <span className="font-mono text-(length:--text-app-body) text-slate-800">
          {nodeTitle(node, DEFAULT_EXCHANGE_LABEL)}
        </span>
        <Badge tone="neutral">{kindLabelOf(node.id)}</Badge>
        <span className="text-(length:--text-app-meta) text-slate-500">
          上游 {rows.filter((row) => row.direction === "in").length} · 下游{" "}
          {rows.filter((row) => row.direction === "out").length}
        </span>
        {health ? <span className="text-(length:--text-app-meta) text-amber-700">{health}</span> : null}
        {node.kind === "queue" ? (
          <NavigateButton
            className="ml-auto"
            size="xs"
            variant="secondary"
            to={messagesPath(connectionId, node.name)}
          >
            查看消息
          </NavigateButton>
        ) : null}
      </div>
      <div className="max-h-48 overflow-auto text-(length:--text-app-body)">
        <NeighbourTable rows={rows} empty={emptyEdgeHint()} />
      </div>
    </div>
  );
}
