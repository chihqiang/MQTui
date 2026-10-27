import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Badge, Button, Empty, ErrorState, GraphSkeleton, SearchInput } from "@/components/ui";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useConsumerGraph } from "@/hooks/use-broker-data";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import {
  HEALTH_LABEL,
  headerStats,
  highlightOf,
  layoutConsumerGraph,
  linkLines,
  matchNodes,
  nodeTitle,
  type LinkBox,
  type LinkLine,
} from "@/lib/consumer-graph";
import { DEFAULT_EXCHANGE_LABEL, kindOf } from "@/types";
import type { ConsumerGraph, LinkNode } from "@/types";

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
  const navigate = useNavigate();
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
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按交换机 / 队列 / 连接名过滤"
          aria-label="过滤消费链路"
          icon
          box="page"
          className="w-64"
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
        layout={layout?.boxes ?? []}
        lines={lines}
        width={(layout?.width ?? 0) + 24}
        height={(layout?.height ?? 0) + 24}
        matched={matched}
        highlight={highlight}
        onSelect={(id) => setSelected((current) => (current === id ? null : id))}
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

/**
 * 画布：绝对定位的节点 + 连线。与拓扑图同一套做法，只是节点多了「连接」一类。
 *
 * 手写 SVG 只限这一层连线（坐标由 `consumer-graph` 算好）；图标仍走 `lib/icons.tsx`。
 */
function GraphBoard({
  layout,
  lines,
  width,
  height,
  matched,
  highlight,
  onSelect,
}: {
  layout: LinkBox[];
  lines: LinkLine[];
  width: number;
  height: number;
  matched: Set<string> | null;
  highlight: { nodes: Set<string>; edges: Set<number> } | null;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-slate-50">
      <div className="relative" style={{ width, height }}>
        <svg
          className="absolute inset-0"
          width={width}
          height={height}
          aria-hidden="true"
          focusable="false"
        >
          {lines.map((line, index) => {
            const related = !hovered || line.edge.from === hovered || line.edge.to === hovered;
            const highlighted = highlight?.edges.has(index) ?? false;
            const consume = line.edge.kind === "consume";
            return (
              <g key={`${line.edge.from}->${line.edge.to}:${line.edge.kind}:${line.edge.label}`}>
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke={highlighted ? "rgb(56 189 248)" : "currentColor"}
                  className="text-slate-600"
                  // 消费边画虚线：绑定是「静态结构」，消费是「当前谁连着」，两者不该长得一样。
                  strokeDasharray={consume ? "4 3" : undefined}
                  strokeWidth={highlighted ? 2 : 1.5}
                  opacity={related ? 1 : 0.25}
                />
                {!consume && line.edge.label ? (
                  <text
                    x={line.labelX}
                    y={line.labelY}
                    textAnchor="middle"
                    className="fill-slate-500 text-(length:--text-app-micro)"
                    opacity={related ? 1 : 0.25}
                  >
                    {line.edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {layout.map((box) => {
          const node = box.node;
          const dimmed =
            (matched !== null && !matched.has(node.id)) ||
            (highlight !== null && !highlight.nodes.has(node.id));
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered((current) => (current === node.id ? null : current))}
              style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              title={`${nodeTitle(node, DEFAULT_EXCHANGE_LABEL)}${node.subtitle ? ` · ${node.subtitle}` : ""}`}
              className={cn(
                "absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-md border px-2 text-left transition-colors",
                toneOf(node),
                dimmed ? "opacity-30" : "opacity-100",
              )}
            >
              <span className="truncate font-mono text-(length:--text-app-meta) text-slate-900">
                {nodeTitle(node, DEFAULT_EXCHANGE_LABEL)}
              </span>
              {node.subtitle ? (
                <span className="truncate text-(length:--text-app-micro) text-slate-500">{node.subtitle}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 节点配色：类型决定色系，连接的健康状态决定边框警示。 */
function toneOf(node: LinkNode): string {
  if (node.kind === "exchange") return "border-sky-300 bg-sky-50 hover:border-sky-500";
  if (node.kind === "queue") return "border-emerald-300 bg-emerald-50 hover:border-emerald-500";
  if (node.health === "warn") return "border-amber-400 bg-amber-50 hover:border-amber-500";
  if (node.health === "idle") return "border-slate-300 bg-white hover:border-slate-400";
  return "border-violet-300 bg-violet-50 hover:border-violet-500";
}

/** 选中节点的上下游明细：图上看不清的是完整连接名与 routing key。 */
function SelectionDetail({
  graph,
  id,
  onOpenQueue,
}: {
  graph: ConsumerGraph;
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
  const kindLabel = { exchange: "交换机", queue: "队列", connection: "消费者连接" }[
    kindOf(node.id)
  ];
  const health = node.health ? HEALTH_LABEL[node.health] : null;

  return (
    <div className="shrink-0 rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
        <span className="font-mono text-(length:--text-app-body) text-slate-800">
          {nodeTitle(node, DEFAULT_EXCHANGE_LABEL)}
        </span>
        <Badge tone={node.kind === "connection" ? "info" : node.kind === "queue" ? "success" : "info"}>
          {kindLabel}
        </Badge>
        <span className="text-(length:--text-app-meta) text-slate-500">
          上游 {incoming.length} · 下游 {outgoing.length}
        </span>
        {health ? <span className="text-(length:--text-app-meta) text-amber-700">{health}</span> : null}
        {node.kind === "queue" ? (
          <button
            type="button"
            className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-(length:--text-app-meta) text-slate-600 hover:bg-slate-100"
            onClick={() => onOpenQueue(node.name)}
          >
            查看消息
          </button>
        ) : null}
      </div>
      <div className="max-h-48 overflow-auto text-(length:--text-app-body)">
        <table className="w-full text-left">
          <tbody>
            {incoming.map((edge) => (
              <tr key={`in-${edge.from}:${edge.kind}`} className="border-b border-slate-200">
                <td className="w-16 px-4 py-1.5 text-(length:--text-app-meta) text-slate-500">上游</td>
                <td className="px-2 py-1.5 font-mono text-slate-600">{nameOf(edge.from)}</td>
                <td className="px-4 py-1.5 font-mono text-slate-500">
                  {edge.label || (edge.kind === "binding" ? "(无 routing key)" : "")}
                </td>
              </tr>
            ))}
            {outgoing.map((edge) => (
              <tr key={`out-${edge.to}:${edge.kind}`} className="border-b border-slate-200">
                <td className="w-16 px-4 py-1.5 text-(length:--text-app-meta) text-slate-500">下游</td>
                <td className="px-2 py-1.5 font-mono text-slate-600">{nameOf(edge.to)}</td>
                <td className="px-4 py-1.5 font-mono text-slate-500">
                  {edge.label || (edge.kind === "binding" ? "(无 routing key)" : "")}
                </td>
              </tr>
            ))}
            {!incoming.length && !outgoing.length ? (
              <tr>
                <td className="px-4 py-2 text-slate-500">这个节点没有任何连线。</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
