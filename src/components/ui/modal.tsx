import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconClose } from "@/lib/icons";

/** 轻量模态框：点击遮罩或按 Esc 关闭。 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  /** 窄弹窗（确认框）用，默认宽度是给表格和 JSON 留的。 */
  size = "md",
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  // 打开就聚焦面板本体：否则 Esc 之外什么都按不动，屏幕阅读器也停在原处。
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-slate-900/25 p-6 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "animate-pop-in flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl",
          "border border-slate-200 bg-white shadow-2xl shadow-slate-900/15 outline-none",
          size === "sm" ? "max-w-md" : "max-w-3xl",
        )}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md p-1 text-meta transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="selectable min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
