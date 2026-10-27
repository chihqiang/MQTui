import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";
import { IconClose, IconSearch } from "@/lib/icons";

const FIELD_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-(length:--text-app-body) text-slate-900 " +
  "shadow-xs transition-colors duration-(--motion-fast) " +
  "placeholder:text-meta hover:border-slate-300 " +
  "focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 focus:outline-none " +
  "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD_CLASS, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD_CLASS, "font-mono", className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(FIELD_CLASS, "cursor-pointer", className)} {...props}>
      {children}
    </select>
  );
}

/**
 * 可清空的输入框。
 *
 * 过滤框里改一个字往往要从头再来，全选删除比按退格更顺手。
 * 只在有值时出现，空框上挂一个 ✕ 是纯粹的视觉噪音。
 *
 * 放大镜也只在 `icon` 打开时出现：一个 64 宽的小过滤框里塞图标，
 * 能看见的字符会少两个，不值。
 */
export function SearchInput({
  value,
  onValueChange,
  className,
  icon = false,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (next: string) => void;
  /** 左侧是否显示放大镜。 */
  icon?: boolean;
}) {
  return (
    <div className="relative min-w-0">
      {icon ? (
        <IconSearch
          size={12}
          className={cn(
            "pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-slate-500",
          )}
        />
      ) : null}
      <input
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        // Esc 清空：过滤场景里比「按 8 次退格」直接得多。
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onValueChange("");
          }
          props.onKeyDown?.(event);
        }}
        className={cn(FIELD_CLASS, icon && "pl-7", value ? "pr-8" : undefined, className)}
        {...props}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="清空"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-meta transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <IconClose size={12} />
        </button>
      ) : null}
    </div>
  );
}

/** 带标签的表单项。`hint` 放「为什么要填这个」，而不是重复标签。 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** 校验失败时的说明，出现即染红，不用另加一行错误文案。 */
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-(length:--text-app-body) text-secondary">{label}</span>
      {children}
      {error ? (
        <span className="text-(length:--text-app-meta) text-rose-700">{error}</span>
      ) : hint ? (
        <span className="text-(length:--text-app-meta) text-meta">{hint}</span>
      ) : null}
    </label>
  );
}
