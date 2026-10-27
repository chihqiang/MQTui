import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconSpinner } from "@/lib/icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "xs" | "sm" | "md";

const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    "bg-accent text-white shadow-xs hover:bg-accent-hover active:bg-accent-active disabled:bg-accent/40 disabled:shadow-none",
  secondary:
    "bg-white text-slate-700 shadow-xs ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100 disabled:text-slate-400",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200/70",
  danger:
    "bg-critical text-white shadow-xs hover:bg-critical-hover active:bg-critical-active disabled:bg-critical/40 disabled:shadow-none",
};

const SIZE_CLASS: Record<Size, string> = {
  xs: "h-6 gap-1 rounded px-1.5 text-(length:--text-app-meta)",
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-8 gap-1.5 rounded-lg px-3 text-xs",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /**
   * 进行中：按钮自动禁用并换成转圈，文字保留。
   *
   * 让「点过了、正在跑」这件事在按钮上就能看见 —— 原来各页面自己写
   * `{pending ? "创建中…" : "创建"}`，禁用状态一漏就会出现重复提交。
   */
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap",
        // 按下时回弹 1px：面板里大量操作是「点一下等结果」，没有回弹的按钮
        // 和一张图没区别。`active:translate-y-px` 比缩放更稳 —— 它不会让
        // 相邻按钮的文字在按下瞬间抖一下。
        "transition-colors duration-(--motion-fast) active:translate-y-px active:duration-0",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    >
      {loading ? <IconSpinner className="animate-spin" /> : icon}
      {children}
    </button>
  );
}
