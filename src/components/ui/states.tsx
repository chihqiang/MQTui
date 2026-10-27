import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { IconAlert, IconInbox } from "@/lib/icons";

import { Skeleton } from "./skeleton";

/** 加载中。给了 `rows` 就画骨架屏，否则退回一行文字。 */
export function Loading({ label = "加载中…", rows }: { label?: string; rows?: number }) {
  if (rows) {
    return (
      <div className="flex flex-col gap-2 p-4" role="status" aria-label={label}>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-5" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-400" role="status">
      <span className="size-3 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      {label}
    </div>
  );
}

/**
 * 空数据。`action` 放下一步能做什么，别让用户停在一句「暂无数据」上。
 *
 * 和 `ErrorState` 刻意拉开距离：空态是**引导**（中性描边图标 + 一个主动作），
 * 错误是**警告**（rose 底 + 图标 + 可复制的原文）。以前两者都是「居中、一段文字、
 * 一个按钮」，远处扫视时分不出「这里没东西」和「这里坏了」。
 */
export function Empty({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "animate-fade-in flex flex-col items-center justify-center gap-2 p-10 text-center",
        className,
      )}
    >
      <div className="mb-1 rounded-full border border-dashed border-slate-700 bg-slate-900/60 p-3 text-slate-500">
        {icon ?? <IconInbox size={18} />}
      </div>
      <p className="text-(length:--text-app-title) font-medium text-slate-300">{title}</p>
      {description ? (
        <p className="max-w-md text-(length:--text-app-meta) text-slate-400">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * 错误展示。正文要能选中复制，排障时经常要贴给别人。
 *
 * 视觉上必须一眼看出「坏了」：rose 描边 + 图标 + 原始错误码块，而不是
 * 换一个文字颜色就当作错误态。
 */
export function ErrorState({
  message,
  onRetry,
  hint,
}: {
  message: string;
  onRetry?: () => void;
  /** 排障提示：比如「检查 broker 是否在监听」。可选，别写成第二段错误。 */
  hint?: string;
}) {
  return (
    <div
      className="animate-fade-in flex flex-col items-center gap-3 rounded-lg border border-rose-900/60 bg-rose-950/20 p-8 text-center"
      role="alert"
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-rose-500/15 text-rose-300">
        <IconAlert size={18} />
      </span>
      <p className="selectable max-w-xl font-mono text-(length:--text-app-body) break-words text-danger">
        {message}
      </p>
      {hint ? <p className="max-w-md text-(length:--text-app-meta) text-slate-400">{hint}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-800"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}

/** 表格/列表首屏的占位行：列宽与真实内容对齐，数据到位时不跳。 */
export function SkeletonTable({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1.5 p-4" role="status" aria-label="加载中">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-6" style={{ width: `${92 - (index % 4) * 6}%` }} />
      ))}
    </div>
  );
}

/**
 * 路由级按需加载的占位。
 *
 * 页面代码分包之后，第一次进入某个功能域要等一次 chunk 下载（本地壳里通常几十
 * 毫秒）。这里刻意铺骨架而不是居中一个转圈：骨架的位置和真实内容一致，
 * 内容到位时不会整块位移 —— 这是「等」和「跳」的区别。
 *
 * 也刻意不铺一整屏：外壳（连接列表、菜单、健康条）是常驻的，内容区只占右侧一块。
 */
export function PageLoading() {
  return (
    <div className="flex h-full flex-col gap-3 p-4" role="status" aria-label="页面加载中">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-64" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-8" style={{ width: `${100 - (index % 4) * 7}%` }} />
        ))}
      </div>
    </div>
  );
}
