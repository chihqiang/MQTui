import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { splitColumns } from "@/lib/monitor-layout";

/**
 * 仪表盘页面的内容区：**整体滚动，卡片分栏**。
 *
 * 和列表页的差别不在样式，在滚动的单位。列表是一行行往下读，滚动天然合理；
 * 仪表盘一屏就是全部内容，正常状态下不该滚 —— 一旦要滚，滚到第二屏时表头
 * 已经不见了，对照上面那行数据得来回翻。
 *
 * 所以这里只做两件事：
 * 1. 按容器宽度把卡片分成 1~3 栏，窄屏自动塌成一栏（不写死 `grid-cols-3`，
 *    否则窗口缩小时卡片会挤成一条）；
 * 2. 卡片数量超过栏数时，**整块内容区**成为一个滚动容器，而不是每张卡片
 *    各滚各的 —— 五个内滚区域并排时，鼠标停在哪一格决定滚的是哪一片，
 *    这是仪表盘上最容易让人烦躁的一处。
 *
 * 单个卡片内部表多、行多（比如一台节点挂 20 个分区）时，用 `MonitorCard`
 * 的 `scroll` 让它自己滚，避免一张卡把整屏高度吃掉。
 */
export function MonitorGrid({
  children,
  /** 单张卡片的最小宽度（px），决定什么时候从 3 栏塌成 2 栏。 */
  minCardWidth = 340,
  /** 最多几栏。信息量少的页面 2 栏比 3 栏更耐看。 */
  maxColumns = 3,
  className,
}: {
  children: ReactNode;
  minCardWidth?: number;
  maxColumns?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // 首帧先拿到宽度，否则会先按 1 栏渲染再跳成 3 栏，整屏闪一下。
    setWidth(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const columns = splitColumns(width, minCardWidth, maxColumns);

  return (
    <div
      ref={ref}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      className={cn("grid min-h-0 flex-1 auto-rows-min content-start gap-3 overflow-auto", className)}
    >
      {children}
    </div>
  );
}

/**
 * 仪表盘里的一张卡：标题一行、正文占满、可选吸底结论。
 *
 * `scroll` 打开后卡片内部滚动，表头吸顶 —— 用于「一张卡里有很多行」的情况
 * （某条连接开了几十个通道）。默认不滚：卡片之间高度参差时，各自的内滚条
 * 让整页看起来像三个互不相干的窗口。
 */
export function MonitorCard({
  title,
  extra,
  footer,
  children,
  scroll = false,
  className,
}: {
  title: ReactNode;
  extra?: ReactNode;
  /** 吸底的一行结论。放「这张卡最要紧的一句话」，不要重复正文。 */
  footer?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col rounded-lg border border-slate-200 bg-white",
        scroll && "max-h-[70vh]",
        className,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <h2 className="min-w-0 truncate text-xs font-medium text-slate-800">{title}</h2>
        {extra ? <div className="flex shrink-0 items-center gap-2">{extra}</div> : null}
      </header>
      <div className={cn("min-h-0 flex-1", scroll && "overflow-auto")}>{children}</div>
      {footer ? (
        <footer className="shrink-0 border-t border-slate-200 px-3 py-1.5 text-(length:--text-app-meta) text-slate-500">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/**
 * 卡片内的一条「标签 → 值」横排事实。
 *
 * 仪表盘里纵向最贵：`DescriptionGrid` 一行只放得下两三项，
 * 这里把标签压到 4rem 定宽、值右对齐，一屏能塞六到八条。
 */
export function FactLine({
  label,
  children,
  tone = "normal",
}: {
  label: ReactNode;
  children: ReactNode;
  tone?: "normal" | "muted" | "danger" | "warning";
}) {
  const toneClass = {
    normal: "text-slate-800",
    muted: "text-slate-500",
    danger: "text-danger",
    warning: "text-warning",
  }[tone];

  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-(length:--text-app-meta)">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={cn("min-w-0 truncate text-right font-mono", toneClass)}>{children}</span>
    </div>
  );
}

/**
 * 横向占比条。
 *
 * `value` 为 `null` 时不画条，只写「未知」—— 上限没上报和「用了 0%」是两件事，
 * 画一根空条子会被读成后者。
 */
export function RatioBar({
  value,
  text,
  tone = "success",
}: {
  value: number | null;
  text: string;
  tone?: "success" | "warning" | "danger";
}) {
  const barClass = {
    success: "bg-success-fill/70",
    warning: "bg-warning-fill/70",
    danger: "bg-danger-fill/70",
  }[tone];

  if (value === null) {
    return <span className="text-(length:--text-app-meta) text-slate-500">{text}</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100">
        <div className={cn("h-full rounded-full", barClass)} style={{ width: `${value * 100}%` }} />
      </div>
      <span className="tabular text-(length:--text-app-meta) text-slate-500">{text}</span>
    </div>
  );
}
