import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { IconAlert, IconClose, IconInbox, IconSpinner } from "@/lib/icons";
import { useSessionStore, type Toast as ToastItem } from "@/stores";

const KIND_CLASS: Record<ToastItem["kind"], string> = {
  success: "border-success/40 bg-success/10 text-success",
  error: "border-danger/40 bg-danger/10 text-danger",
  info: "border-info/40 bg-info/10 text-info",
  progress: "border-slate-600/60 bg-slate-800/90 text-slate-200",
};

/** 报错多留一会儿：一行红字三秒半就消失，等于没说。 */
const DURATION: Record<ToastItem["kind"], number> = {
  success: 2500,
  info: 3000,
  error: 6000,
  progress: Infinity,
};

/**
 * Toast 容器：右下角堆叠，最多三条。
 *
 * 只保留最近三条不是为了省像素，而是报错连发时（比如批量处置逐条失败）
 * 一次刷出十几条会把整个右下角糊满，反而一条都读不进去。
 */
export function ToastViewport() {
  const toasts = useSessionStore((state) => state.toasts);
  const visible = toasts.slice(-3);

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col items-end gap-2">
      {visible.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismiss = useSessionStore((state) => state.dismissToast);

  useEffect(() => {
    const duration = DURATION[toast.kind];
    if (!Number.isFinite(duration)) return;
    const timer = window.setTimeout(() => dismiss(toast.id), duration);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.id, toast.kind]);

  return (
    <div
      role="status"
      className={cn(
        "animate-slide-up pointer-events-auto flex w-full items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg",
        KIND_CLASS[toast.kind],
      )}
    >
      <span className="mt-px shrink-0">
        {toast.kind === "error" ? (
          <IconAlert />
        ) : toast.kind === "progress" ? (
          <IconSpinner className="animate-spin" />
        ) : (
          <IconInbox />
        )}
      </span>
      <span className="selectable min-w-0 flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="关闭提示"
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
