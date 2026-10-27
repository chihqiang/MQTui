import type { ReactNode } from "react";

import { SearchInput } from "@/components/ui";

/**
 * 列表页 / 图页顶部的「过滤 + 只看问题 + 计数」一行。
 *
 * 这行原来在主题、队列、交换机、策略、参数、运行时、拓扑、路由、消费组……
 * 十来个页面各拼一遍 `PageToolbar` + `SearchInput` + `<label><input type=checkbox>`。
 * 拼法略有差异是可以忍受的，问题是「命中计数」的措辞也各不相同：
 * 有的写「共 N 个」，有的写「N 条里有 M 条」，用户得逐个页面重新理解。
 */
export function FilterBar({
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  /** 右侧那行计数，由页面给（它知道「个」是队列还是主题）。 */
  summary,
  /** 只有真的能筛「只看有问题」的页面才给。 */
  onlyIssue,
  className,
}: {
  value: string;
  onValueChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  summary?: ReactNode;
  onlyIssue?: {
    checked: boolean;
    onChange: (next: boolean) => void;
    label: string;
  };
  className?: string;
}) {
  return (
    <>
      <SearchInput
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        icon
        box="page"
        className={className ?? "w-64"}
      />
      {onlyIssue ? (
        <label className="flex items-center gap-2 text-(length:--text-app-body) text-slate-600">
          <input
            type="checkbox"
            checked={onlyIssue.checked}
            onChange={(event) => onlyIssue.onChange(event.currentTarget.checked)}
          />
          {onlyIssue.label}
        </label>
      ) : null}
      {summary ? (
        <span className="ml-auto text-(length:--text-app-body) text-slate-500">{summary}</span>
      ) : null}
    </>
  );
}
