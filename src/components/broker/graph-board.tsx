import { useState } from "react";

import { cn } from "@/lib/cn";

/** 画布上的一条线。坐标由 `lib/*-graph.ts` 算好，这里只画。 */
export interface GraphBoardLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 标签位置；不画标签时留空。 */
  labelX?: number;
  labelY?: number;
  label?: string;
  /** 虚线：静态结构画实线，当前连接画虚线，两者不该长得一样。 */
  dashed?: boolean;
  /** 是否属于当前高亮的子图。 */
  highlighted?: boolean;
  /** 这条线两端的节点 id，用于悬停时压暗无关的线。 */
  ends?: [string, string];
}

/** 画布上的一个节点。 */
export interface GraphBoardNode {
  id: string;
  /** 节点上的主标题与副标题，已由调用方算好（默认交换机要显示成人话）。 */
  title: string;
  subtitle?: string;
  hint?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 边框与底色类名，由「节点类型 + 健康状态」决定。 */
  tone: string;
  /** 被过滤或未被选中时压暗。 */
  dimmed?: boolean;
}

/**
 * 拓扑 / 消费链路共用的画布。
 *
 * 两张图原来各写一遍「SVG 画线 + 绝对定位画框」，区别只有线的虚实与节点配色。
 * 抄第二遍时两边的悬停压暗规则就已经不一样了 —— 同一块画布，一边悬停会压暗
 * 其它节点，另一边不会。坐标仍由 `lib` 算，这里只管画。
 */
export function GraphBoard({
  nodes,
  lines,
  width,
  height,
  onSelect,
}: {
  nodes: GraphBoardNode[];
  lines: GraphBoardLine[];
  width: number;
  height: number;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-slate-50">
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0" width={width} height={height} aria-hidden="true" focusable="false">
          {lines.map((line) => {
            // 悬停时只留与这个节点相连的线：几百条边的图上，其余线会把结论糊住。
            const related = !hovered || !line.ends || line.ends.includes(hovered);
            const dim = related ? 1 : 0.25;
            return (
              <g key={line.id}>
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  stroke={line.highlighted ? "rgb(56 189 248)" : "currentColor"}
                  className="text-slate-600"
                  strokeDasharray={line.dashed ? "4 3" : undefined}
                  strokeWidth={line.highlighted ? 2 : 1.5}
                  opacity={dim}
                />
                {line.label && line.labelX !== undefined && line.labelY !== undefined ? (
                  <text
                    x={line.labelX}
                    y={line.labelY}
                    textAnchor="middle"
                    className="fill-slate-500 text-(length:--text-app-micro)"
                    opacity={dim}
                  >
                    {line.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node.id)}
            onMouseEnter={() => setHovered(node.id)}
            onMouseLeave={() => setHovered((current) => (current === node.id ? null : current))}
            style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            title={node.hint ?? node.title}
            className={cn(
              "absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-md border px-2 text-left transition-colors",
              node.tone,
              node.dimmed ? "opacity-30" : "opacity-100",
            )}
          >
            <span className="truncate font-mono text-(length:--text-app-meta) text-slate-900">{node.title}</span>
            {node.subtitle ? (
              <span className="truncate text-(length:--text-app-micro) text-slate-500">{node.subtitle}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
