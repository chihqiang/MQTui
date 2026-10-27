import { Skeleton } from "./skeleton";

/**
 * 图的骨架：画布位置先留出来，读完之后图直接落进去。
 *
 * 两张图（拓扑 / 消费链路）的首屏原本是转圈，转完画布高度从 0 跳到几百像素，
 * 搜索框和按钮跟着往下走一截——用户刚想去点过滤框就被挪走了。
 */
export function GraphSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-4" role="status" aria-label={label}>
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="ml-auto h-4 w-48" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-slate-200 p-4">
        <div className="flex flex-1 items-center gap-4">
          <Skeleton className="h-24 w-40" />
          <Skeleton className="h-px flex-1" />
          <Skeleton className="h-24 w-40" />
          <Skeleton className="h-px flex-1" />
          <Skeleton className="h-24 w-40" />
        </div>
        <p className="text-center text-xs text-slate-500">{label}</p>
      </div>
    </div>
  );
}
