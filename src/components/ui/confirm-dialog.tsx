import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Field, Input } from "./input";
import { Modal } from "./modal";

/**
 * 二次确认，替代 `window.confirm`。
 *
 * 三件原生 confirm 做不到、但这套面板天天要的事：
 * 1. 说清「会失去什么」—— 删除队列和清空消息的后果量级完全不同；
 * 2. 危险操作要求手打确认串（可以选填），让手比眼慢一拍；
 * 3. 不阻塞 WebView，弹窗开着的同时还能看到背后的数据。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确认",
  danger = false,
  loading = false,
  /** 填了就要求用户手打这段文字才能提交。 */
  requirePhrase,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  requirePhrase?: string;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [phrase, setPhrase] = useState("");

  // 每次打开都从空开始：留着上次打过的文字，确认就变成了点两下。
  useEffect(() => {
    if (open) setPhrase("");
  }, [open]);

  const matched = !requirePhrase || phrase.trim() === requirePhrase;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!matched || loading}
            aria-busy={loading || undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              danger
                ? "bg-critical text-white hover:bg-critical-hover"
                : "bg-accent text-white hover:bg-accent-hover",
            )}
          >
            {loading ? "处理中…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {description ? (
          <div className="selectable text-xs leading-relaxed text-slate-400">{description}</div>
        ) : null}
        {children}
        {requirePhrase ? (
          <Field label="手打下面这段以确认">
            <Input
              value={phrase}
              onChange={(event) => setPhrase(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matched && !loading) onConfirm();
              }}
              autoFocus
              spellCheck={false}
              placeholder={requirePhrase}
              className={cn("h-8 font-mono text-xs", matched ? undefined : "border-slate-700")}
            />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
