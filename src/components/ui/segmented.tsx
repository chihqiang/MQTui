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
      // 底槽用浅灰而不是白：一段白底的分段开关落在白卡片上，两边都只剩一条描边，
      // 用户分不清「这是一个控件」还是「两个并排按钮」。
      className={cn(
        "inline-flex shrink-0 gap-0.5 rounded-md bg-slate-100 p-0.5",
        className,
      )}
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
              // 选中态是「浅灰槽里的一块白」—— 与全站卡片同一套层级语言：
              // 白 = 当前，灰 = 底。以前选中项和未选中项都带白色描边，
              // 目光扫过去分不出哪一段是结果、哪一段是候选。
              active
                ? "bg-white font-medium text-indigo-700 shadow-xs"
                : "text-slate-500 hover:bg-slate-200/60 hover:text-slate-800",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
