import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorState,
  GraphCanvas,
  GraphSkeleton,
  SearchInput,
} from "@/components/ui";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import type { CanvasNode } from "@/components/ui";
import { useTopologyGraph } from "@/hooks/use-broker-data";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import {
  highlightOf,
  layoutGraph,
  matchNodes,
  nodeTitle,
} from "@/lib/topology-graph";
import { DEFAULT_EXCHANGE_LABEL, type TopologyGraph } from "@/types";

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
  const navigate = useNavigate();
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

  const nodes: CanvasNode[] = (layout?.boxes ?? []).map((box) => {
    const node = box.node;
    const dimmed =
      (matched !== null && !matched.has(node.id)) ||
      (highlight !== null && !highlight.nodes.has(node.id));
    return {
      id: node.id,
      box,
      title: nodeTitle(node, DEFAULT_EXCHANGE_LABEL),
      subtitle: subtitleOf(node),
      tone: node.kind === "queue" ? "queue" : "exchange",
      dimmed,
      onClick: () =>
        setSelected((current) => (current === node.id ? null : node.id)),
    };
  });

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
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按名称 / routing key 过滤"
          aria-label="过滤拓扑"
          className="h-8 w-64 text-(length:--text-app-body)"
        />
      </PageToolbar>

      {data.omitted ? (
        <p className="text-(length:--text-app-body) text-amber-700">
          拓扑规模超过绘图上限，还有 {formatNumber(data.omitted)} 个节点没画出来。
          这一页回答「结构长什么样」，全量数据请看「交换机」页。
        </p>
      ) : null}

      <GraphCanvas
        nodes={nodes}
        edges={data.edges}
        width={(layout?.width ?? 0) + 24}
        height={(layout?.height ?? 0) + 24}
      />

      {selected ? (
        <SelectionDetail
          graph={data}
          id={selected}
          onOpenQueue={(queue) =>
            navigate(`/connections/${connectionId}/messages?target=${encodeURIComponent(queue)}`)
          }
        />
      ) : null}
    </PageBody>
  );
}

/** 节点副标题：队列给堆积与消费者，交换机给类型。 */
function subtitleOf(node: TopologyGraph["nodes"][number]): string | undefined {
  if (node.kind === "queue") {
    const messages = node.messages ?? 0;
    const consumers = node.consumers ?? 0;
    return `${formatNumber(messages)} 条 · ${consumers} 消费者`;
  }
  return node.name === "" ? "隐式按队列名投递" : "交换机";
}

/** 选中节点的上下游明细：图上看不清的是 routing key，这里逐条列出来。 */
function SelectionDetail({
  graph,
  id,
  onOpenQueue,
}: {
  graph: TopologyGraph;
  id: string;
  onOpenQueue: (queue: string) => void;
}) {
  const node = graph.nodes.find((item) => item.id === id);
  if (!node) return null;
  const incoming = graph.edges.filter((edge) => edge.to === id);
  const outgoing = graph.edges.filter((edge) => edge.from === id);
  const nameOf = (nodeId: string) => {
    const found = graph.nodes.find((item) => item.id === nodeId);
    return found ? nodeTitle(found, DEFAULT_EXCHANGE_LABEL) : nodeId;
  };

  return (
    <Card className="shrink-0">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono text-(length:--text-app-body) text-slate-800">
              {nodeTitle(node, DEFAULT_EXCHANGE_LABEL)}
            </span>
            <Badge tone={node.kind === "queue" ? "success" : "info"}>
              {node.kind === "queue" ? "队列" : "交换机"}
            </Badge>
            <span className="text-(length:--text-app-meta) text-slate-500">
              上游 {incoming.length} · 下游 {outgoing.length}
            </span>
          </span>
        }
        extra={
          node.kind === "queue" ? (
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-0.5 text-(length:--text-app-meta) text-slate-600 hover:bg-slate-100"
              onClick={() => onOpenQueue(node.name)}
            >
              查看消息
            </button>
          ) : null
        }
      />
      <CardBody className="max-h-48 overflow-auto p-0 text-(length:--text-app-body)">
        <table className="w-full text-left">
          <tbody>
            {incoming.map((edge) => (
              <tr key={`in-${edge.from}`} className="border-b border-slate-200">
                <td className="w-16 px-4 py-1.5 text-(length:--text-app-meta) text-slate-500">上游</td>
                <td className="px-2 py-1.5 font-mono text-slate-600">{nameOf(edge.from)}</td>
                <td className="px-4 py-1.5 font-mono text-slate-500">
                  {edge.routingKey || "(无 routing key)"}
                </td>
              </tr>
            ))}
            {outgoing.map((edge) => (
              <tr key={`out-${edge.to}`} className="border-b border-slate-200">
                <td className="w-16 px-4 py-1.5 text-(length:--text-app-meta) text-slate-500">下游</td>
                <td className="px-2 py-1.5 font-mono text-slate-600">{nameOf(edge.to)}</td>
                <td className="px-4 py-1.5 font-mono text-slate-500">
                  {edge.routingKey || "(无 routing key)"}
                </td>
              </tr>
            ))}
            {!incoming.length && !outgoing.length ? (
              <tr>
                <td className="px-4 py-2 text-slate-500">
                  {node.kind === "exchange"
                    ? "这个交换机没有任何绑定：消息进入后会被静默丢弃。"
                    : "这个队列没有被任何交换机绑定：只能按队列名直投。"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
