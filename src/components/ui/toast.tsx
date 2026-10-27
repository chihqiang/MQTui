import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { useSessionStore, type Toast as ToastItem } from "@/stores";

const KIND_CLASS: Record<ToastItem["kind"], string> = {
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  error: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-200",
};

/** 自动消失的 toast 容器。 */
export function ToastViewport() {
  const toasts = useSessionStore((state) => state.toasts);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const dismiss = useSessionStore((state) => state.dismissToast);

  // 3.5s 后自动关闭，期间用户可点击关闭。
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), 3500);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.id]);

  return (
    <button
      type="button"
      onClick={() => dismiss(toast.id)}
      className={cn(
        "pointer-events-auto rounded-md border px-3 py-2 text-left text-xs shadow-lg",
        KIND_CLASS[toast.kind],
      )}
    >
      {toast.message}
    </button>
  );
}
