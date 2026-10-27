import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * 「标签 → 值」的紧凑清单，用于弹窗里摆原消息、原队列这类事实。
 *
 * 与 `DescriptionGrid` 的分工：那边是详情页的散装事实（值可能是徽标、多行文本），
 * 这边是**确认框里的几句话**，一律等宽字体、一行一个，读的是「名字对不对」。
 *
 * 这个块在消息详情、重投、重发、批量处置、断开消费者五个界面里各写过一遍，
 * 五份的间距与字号逐渐分叉 —— 所以收成一个原语。
 */
export function MetaGrid({
  items,
  columns = 2,
  className,
}: {
  items: readonly { label: string; value: ReactNode }[];
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const columnClass = {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-3",
  }[columns];

  return (
    <dl
      className={cn(
        "grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-(length:--text-app-body)",
        columnClass,
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-(length:--text-app-meta) text-meta">{item.label}</dt>
          <dd className="truncate font-mono text-slate-800" title={typeof item.value === "string" ? item.value : undefined}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 单条事实。需要更自由的排版时（比如右上角挂个按钮）用它，不要复制 `MetaGrid` 的内部结构。 */
export function MetaItem({
  label,
  value,
  action,
  className,
}: {
  label: string;
  value: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded border border-slate-200 px-2 py-1.5", className)}>
      <dt className="flex items-center gap-1 text-(length:--text-app-micro) font-medium tracking-wide text-secondary uppercase">
        <span className="min-w-0 truncate">{label}</span>
        {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      </dt>
      <dd className="mt-0.5 min-w-0 truncate font-mono text-(length:--text-app-body) text-slate-800">
        {value}
      </dd>
    </div>
  );
}
