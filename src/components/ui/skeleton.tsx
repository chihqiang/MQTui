import type { CSSProperties } from "react";

import { cn } from "@/lib/cn";

/**
 * 骨架屏。
 *
 * 比「加载中…」多给一点信息：占位的形状就是内容将来的形状，数据到位时
 * 页面不会整体跳动。最后一行刻意收窄，视觉上有收尾，不像被截断。
 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn(
        "animate-shimmer rounded bg-linear-to-r from-slate-800 via-slate-700/60 to-slate-800",
        "bg-[length:200%_100%]",
        className,
      )}
    />
  );
}

/**
 * 若干行骨架，`rows` 控制行数，用来顶替列表/表格的首屏。
 *
 * 默认对读屏器隐藏（外层通常已经有 `role="status"` 的说明文字）；
 * 单独顶掉整块内容时打开 `label`，让它自己承担「正在加载」这句话。
 */
export function SkeletonRows({
  rows = 6,
  className,
  label,
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-4", className)}
      {...(label ? { role: "status" as const, "aria-label": label } : { "aria-hidden": true })}
    >
      {Array.from({ length: rows }, (_, index) => (
        // 最后一行短一些，视觉上有收尾，不会像被截断。
        <Skeleton key={index} className="h-4" style={index === rows - 1 ? { width: "60%" } : undefined} />
      ))}
    </div>
  );
}
