import { useMemo, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { NODE_HEIGHT, NODE_WIDTH, edgeLines, type NodeBox } from "@/lib/topology-graph";

/** 画布上节点的渲染信息，由使用方给出（颜色、文案、点击行为各不相同）。 */
export interface CanvasNode {
  id: string;
  box: NodeBox;
  title: string;
  subtitle?: string;
  tone?: "exchange" | "queue";
  dimmed?: boolean;
  onClick?: () => void;
}

/**
 * 分层拓扑画布：绝对定位的节点 + SVG 连线。
 *
 * 不用力导向布局（见 `lib/topology-graph.ts` 的说明），也不引入图形库——
 * 这里需要的只是「按算好的坐标摆框、连线、点击高亮」，一个 400 行的
 * 图形库会带进一整套自己的坐标体系，反而和固定分层打架。
 */
export function GraphCanvas({
  nodes,
  edges,
  width,
  height,
  footer,
}: {
  nodes: CanvasNode[];
  edges: { from: string; to: string; routingKey: string }[];
  width: number;
  height: number;
  footer?: ReactNode;
}) {
  // 连线需要在节点坐标表里查端点，这里从渲染信息反推回 `NodeBox`。
  const boxes = useMemo(() => nodes.map((item) => item.box), [nodes]);
  const lines = useMemo(
    () =>
      edgeLines(
        edges.map((edge) => ({ from: edge.from, to: edge.to, routingKey: edge.routingKey })),
        boxes,
      ),
    [edges, boxes],
  );

  const [hovered, setHovered] = useState<string | null>(null);

  if (!nodes.length) {
    return <>{footer}</>;
  }

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
          {lines.map((line) => {
            // 悬停某个节点时，与它无关的线淡下去。不隐藏：结构必须一直看得见。
            const related =
              !hovered || line.edge.from === hovered || line.edge.to === hovered;
            return (
              <g key={`${line.edge.from}->${line.edge.to}:${line.edge.routingKey}`}>
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke="currentColor"
                  className={cn(
                    "text-slate-300 transition-opacity",
                    related ? "opacity-100" : "opacity-25",
                  )}
                  strokeWidth={1.5}
                />
                {line.edge.routingKey ? (
                  <text
                    x={line.labelX}
                    y={line.labelY}
                    textAnchor="middle"
                    className={cn(
                      "fill-slate-500 text-(length:--text-app-micro)",
                      related ? "opacity-100" : "opacity-25",
                    )}
                  >
                    {line.edge.routingKey}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {nodes.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            onMouseEnter={() => setHovered(item.id)}
            onMouseLeave={() => setHovered((current) => (current === item.id ? null : current))}
            style={{
              left: item.box.x,
              top: item.box.y,
              width: NODE_WIDTH,
              height: NODE_HEIGHT,
            }}
            title={`${item.title}${item.subtitle ? ` · ${item.subtitle}` : ""}`}
            className={cn(
              "absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-md border px-2 text-left transition-colors",
              item.tone === "queue"
                ? "border-emerald-300 bg-emerald-50 hover:border-emerald-500"
                : "border-indigo-200 bg-indigo-50 hover:border-indigo-500",
              item.dimmed ? "opacity-30" : "opacity-100",
            )}
          >
            <span className="truncate font-mono text-(length:--text-app-meta) text-slate-900">{item.title}</span>
            {item.subtitle ? (
              <span className="truncate text-(length:--text-app-micro) text-slate-500">{item.subtitle}</span>
            ) : null}
          </button>
        ))}
      </div>
      {footer}
    </div>
  );
}
