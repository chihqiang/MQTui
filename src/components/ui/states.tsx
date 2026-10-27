import type { ReactNode } from "react";

/** 加载中。 */
export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-400">
      <span className="size-3 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
      {label}
    </div>
  );
}

/** 空数据。 */
export function Empty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
      <p className="text-sm text-slate-300">{title}</p>
      {description ? <p className="text-xs text-slate-500">{description}</p> : null}
      {action}
    </div>
  );
}

/** 错误展示。 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-10 text-center">
      <p className="text-sm text-rose-300">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
