import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * 详情页的「事实栏」。
 *
 * 详情页开头总是一片「标签 → 值」：队列的状态 / 消费者数 / 队列参数，
 * 消费组的成员数 / 总滞后，运行时的连接账号 / 通道数。原来每个详情页
 * 手写一遍 `grid-cols-2 sm:grid-cols-3` + `<dl>`，列数各不相同，翻页时
 * 数字会左右跳。这里把这一块收成一个原语。
 *
 * 与 `Table` 的分工：这里是「看一眼就够」的散装事实，不是需要逐行对照的
 * 记录。超过 12 项、或者每项都要横向比较时，应该用 `DataTable`。
 */

export interface DescriptionItem {
  label: string;
  /** 值可以是徽标、多行文本；纯文本会按等宽字体渲染。 */
  value: ReactNode;
  /** 占两列。地址、JSON 片段这类长值用它，别让一行挤成三四截。 */
  wide?: boolean;
  /** 这一项有问题时染红，一眼挑出来。 */
  tone?: "normal" | "danger" | "warning";
}

const TONE_CLASS = {
  normal: "text-slate-800",
  danger: "text-rose-700",
  warning: "text-warning",
} as const;

export function DescriptionGrid({
  items,
  /** 列数。默认 3 列；事实少的时候 2 列更像一张卡片而不是一张空表格。 */
  columns = 3,
  className,
}: {
  items: DescriptionItem[];
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  const columnClass = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
  }[columns];

  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-2 text-xs", columnClass, className)}>
      {items.map((item) => (
        <div key={item.label} className={cn("flex min-w-0 flex-col gap-0.5", item.wide && "sm:col-span-full")}>
          <dt className="text-(length:--text-app-meta) text-meta">{item.label}</dt>
          <dd className={cn("min-w-0 font-mono", TONE_CLASS[item.tone ?? "normal"])}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 详情页里的区块小标题。
 *
 * 比 `CardHeader` 轻一级：详情页往往在一个弹窗/一页里塞三四个小节，
 * 每节都套一张卡片会显得碎，这里只给一行标题。
 */
export function SectionTitle({
  children,
  extra,
  className,
}: {
  children: ReactNode;
  /** 右侧的补充说明，比如「共 128 个」。 */
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-1.5 flex items-baseline gap-2", className)}>
      <h4 className="text-(length:--text-app-meta) tracking-wide text-slate-500 uppercase">{children}</h4>
      {extra ? <span className="text-(length:--text-app-meta) text-meta">{extra}</span> : null}
    </div>
  );
}

/**
 * 一屏结论条：把「这页最重要的一句话」放在最上面。
 *
 * 仪表类页面的第一句话应该是结论，不是数据。用 `tone` 染边而不是整块染底 ——
 * 一屏里出现两条整块红底，人反而不知道该看哪条。
 */
export function Callout({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
}) {
  const toneClass = {
    info: "border-slate-300 text-slate-600",
    success: "border-success/30 text-success",
    warning: "border-warning/30 text-warning",
    danger: "border-danger/30 text-danger",
  }[tone];

  return (
    <p
      className={cn(
        "animate-fade-in rounded-md border-l-2 bg-white py-1.5 pr-3 pl-2.5 text-xs",
        toneClass,
        className,
      )}
    >
      {children}
    </p>
  );
}
