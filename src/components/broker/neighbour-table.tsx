import type { ReactNode } from "react";

/**
 * 图上选中节点后的「上游 / 下游」明细。
 *
 * 画布只回答「谁连着谁」，看不清的是 routing key、完整连接名、以及
 * 「这个节点压根没有连线」这种结论 —— 那三件事都在这里逐行说清。
 *
 * 拓扑图与消费链路图原来各有一份，连「(无 routing key)」这句兜底文案
 * 都是一样的，只是键名不同。合成一个，行由调用方算。
 */
export interface NeighbourRow {
  /** `in`（上游）或 `out`（下游）。 */
  direction: "in" | "out";
  /** 唯一键：同一对节点之间可以有多条不同 routing key 的边。 */
  key: string;
  /** 对端节点名。 */
  name: string;
  /** routing key 一类的标签；空串表示「没有标签」而不是「标签是空」。 */
  label: string;
}

const DIRECTION_LABEL = { in: "上游", out: "下游" } as const;

export function NeighbourTable({
  rows,
  empty,
}: {
  rows: readonly NeighbourRow[];
  /** 一条连线都没有时说的话。两种图对「没有边」的解释并不一样。 */
  empty: ReactNode;
}) {
  return (
    <table className="w-full text-left">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-slate-200">
            <td className="w-16 px-4 py-1.5 text-(length:--text-app-meta) text-slate-500">
              {DIRECTION_LABEL[row.direction]}
            </td>
            <td className="px-2 py-1.5 font-mono text-slate-600">{row.name}</td>
            <td className="px-4 py-1.5 font-mono text-slate-500">{row.label || "(无 routing key)"}</td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td className="px-4 py-2 text-slate-500">{empty}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
