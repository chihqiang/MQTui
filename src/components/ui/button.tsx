import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconSpinner } from "@/lib/icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "xs" | "sm" | "md";

const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    "bg-accent text-white shadow-xs hover:bg-accent-hover active:bg-accent-active disabled:bg-accent/40 disabled:shadow-none",
  secondary:
    "bg-white text-slate-700 shadow-xs ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100 disabled:text-meta",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200/70",
  danger:
    "bg-critical text-white shadow-xs hover:bg-critical-hover active:bg-critical-active disabled:bg-critical/40 disabled:shadow-none",
};

/**
 * 尺寸。三档，高度 24 / 30 / 34。
 *
 * 早先是 24 / 28 / 32 且都只给 12px 字 —— 按钮看着像标签，一行里排三个
 * 「编辑连接 / 重连 / 删除」时，最右那个总像临时贴上去的。整梯抬了一档：
 * - `xs`（24px）：表格行内、一行里出现三个以上按钮时的配角；
 * - `sm`（30px）：工具栏、列表行上的主动作；
 * - `md`（34px）：页头、弹窗页脚这类一屏只有一两个的地方。
 *
 * 桌面面板里一排按钮常挤在一起，所以 `xs` 仍然守住 24px 的手指点选下限。
 */
const SIZE_CLASS: Record<Size, string> = {
  xs: "h-6 gap-1 rounded-md px-2 text-(length:--text-app-micro)",
  sm: "h-7.5 gap-1.5 rounded-md px-2.5 text-(length:--text-app-body)",
  md: "h-8.5 gap-1.5 rounded-lg px-3.5 text-(length:--text-app-body)",
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
        // `cursor-pointer`：Tailwind 4 的 preflight 不再给 button 手型，
        // 而桌面应用里「能点的文字」没有手型会被当成标签。
        "inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap",
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
