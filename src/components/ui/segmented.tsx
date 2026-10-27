import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** 悬停说明：光看名字分不清两段差别时，靠它补一句。 */
  title?: string;
}

/**
 * 分段切换（浏览 / 定位）。
 *
 * 比一排按钮更省地方，也比 select 少一次点击：两个选项都摊开，能直接比。
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex shrink-0 gap-0.5 rounded-md bg-slate-900 p-0.5", className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
              // 未选中项也要给颜色反馈：以前它只是「变亮一点」，两个选项都摊开时
              // 到底会切到哪儿全靠猜。用虚线内描边做预览，按下才换成实底色。
              active
                ? "bg-selection-quiet text-slate-100"
                : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 hover:ring-1 hover:ring-slate-700 hover:ring-inset",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
