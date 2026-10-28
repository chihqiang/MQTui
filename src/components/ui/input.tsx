import {
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";
import { IconChevronDown, IconClose, IconSearch } from "@/lib/icons";

export const FIELD_CLASS =
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

/**
 * 下拉框。
 *
 * 外观必须自己画：原生 `<select>` 在 Chromium/WebKit 里自带一圈斜面按钮，
 * 灰底、深色描边、右侧那块「上下箭头」的凸起，和这一套白底细描边的输入框
 * 放在同一行里像是两个年代的东西。`appearance-none` 只去掉控件外观，
 * 箭头要自己补 —— 所以右边多留 28px 给它（`pr-7`）。
 *
 * 高度仍由 `FIELD_CLASS` 的内边距撑：拉起一个 `h-8` 的外层容器会压过内边距，
 * 填在弹窗表单里看着就比旁边的 `Input` 矮一截。要对齐工具条那排控件，
 * 由页面在 `className` 里写高度。
 */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative min-w-0">
      <select
        className={cn(
          FIELD_CLASS,
          // `pr-7` 是给自绘箭头留的位置，写死在组件里，页面传 `pr-*` 也压不掉它。
          "cursor-pointer appearance-none truncate pr-7",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <IconChevronDown
        size={12}
        className="pointer-events-none absolute top-0 right-2 bottom-0 my-auto text-slate-400"
      />
    </div>
  );
}

/**
 * 可清空的输入框。
 *
 * 过滤框里改一个字往往要从头再来，全选删除比按退格更顺手。
 * 只在有值时出现，空框上挂一个 ✕ 是纯粹的视觉噪音。
 *
 * 几处对齐上的坑：
 * 1. **放大镜和 ✕ 用同一个垂直基准**。原来左边是 12px 图标靠 `top-1/2`
 *    定位（按图标盒子算中线）、右边是 `p-1` 的按钮（按文字盒子算中线），
 *    两个中线不是同一条，看起来像手工摆的。现在左右都用 `size-6` 的盒子
 *    撑满高度再居中，`pl-8` / `pr-8` 与盒子尺寸共用同一个数。
 * 2. **内边距写死，不跟着图标出现/消失跳**。`pl-` 只由 `icon` 决定，
 *    `pr-` 一直留着 —— 否则一打字整行文字会左移 20px。
 * 3. **焦点环画在容器上**。输入框自己套一层胶囊是为了让图标和触发区
 *    一起变色；如果焦点环还留在 `<input>` 内层，就会出现「双层描边」。
 *    这里把内层摊平，`group` 里只留一个真正的 `input`。
 *
 * `box` 是尺寸档：`page` 给页头工具条（32px），`inline` 给工具栏里
 * 紧挨着按钮的小过滤框（28px）。两档只在高度和圆角上不同。
 */
export function SearchInput({
  value,
  onValueChange,
  className,
  icon = false,
  box = "inline",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size"> & {
  value: string;
  onValueChange: (next: string) => void;
  /** 左侧是否显示放大镜。 */
  icon?: boolean;
  /** 尺寸档：页头工具条用 `page`，行内工具栏用 `inline`。 */
  box?: "page" | "inline";
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={cn(
        "group relative min-w-0 cursor-text border border-slate-200 bg-white shadow-xs",
        box === "page" ? "h-8.5 rounded-lg" : "h-8 rounded-lg",
        "transition-colors duration-(--motion-fast)",
        "hover:border-slate-300",
        "focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/15",
        className,
        // 容器接管了边框与焦点环，输入框自己不再画（见下面的 `border-0 shadow-none`）。
        // Tailwind 的工具类顺序由层叠决定，这里用 `[&>input]` 覆盖干净。
        "[&>input]:rounded-none [&>input]:border-0 [&>input]:bg-transparent [&>input]:shadow-none",
        "[&>input]:focus:border-0 [&>input]:focus:ring-0",
      )}
      // 点空白处（图标、右内边距）也要能进来打字：这两块加起来快 30px，
      // 是这类输入框里最容易点到又最没反应的地方。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {icon ? (
        <IconSearch
          size={12}
          className="pointer-events-none absolute top-0 bottom-0 left-0 my-auto ml-2 text-meta transition-colors group-focus-within:text-indigo-500"
        />
      ) : null}
      <input
        ref={inputRef}
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
        className={cn(
          FIELD_CLASS,
          "h-full rounded-none border-0 bg-transparent px-0 shadow-none",
          icon ? "pl-8" : "pl-2.5",
          // 清空键的位置一直占着，打字时文字不会横向跳。
          "pr-8",
        )}
        {...props}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="清空"
          className="absolute top-0 right-1 bottom-0 my-auto flex size-6 items-center justify-center rounded text-meta transition-colors hover:bg-slate-100 hover:text-slate-700"
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
