import type { CSSProperties } from "react";

import { cn } from "@/lib/cn";

/**
 * 骨架屏。
 *
 * 比「加载中…」多给一点信息：占位的形状就是内容将来的形状，数据到位时
 * 页面不会整体跳动。最后一行刻意收窄，视觉上有收尾，不像被截断。
 *
 * 底色必须是**浅色**。这里原来是 `slate-800 → slate-700` 的深色渐变，是深色主题
 * 时期的遗留：浅色界面上每一个骨架块都变成一条深灰杠，整屏看下去像玻璃碎了一地，
 * 而且只要哪一页还在等数据，这一页就长得像坏了。用 slate-200 ↔ slate-100
 * 的微光代替 —— 占位应该安静，不该比内容更响。
 */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={style}
      className={cn(
        "animate-shimmer rounded bg-linear-to-r from-slate-200 via-slate-100 to-slate-200",
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
