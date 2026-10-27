import type { ReactNode } from "react";

/** 行内小动作。悬停才出现，避免满屏按钮抢走内容。 */
export function RowAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-slate-300 px-1.5 py-0.5 text-(length:--text-app-meta) text-slate-600 transition-colors hover:border-accent hover:text-info"
    >
      {icon}
      {label}
    </button>
  );
}
