import { useEffect, useRef, type ReactNode } from "react";

import { useCommandPalette } from "@/hooks/use-command-palette";
import { cn } from "@/lib/cn";

import { DENSITY_OPTIONS } from "@/lib/list-view";
import { usePreferences } from "@/hooks/use-preferences";
import { IconSearch } from "@/lib/icons";

/**
 * 全局命令面板：⌘K / Ctrl+K 打开，输入即筛，回车跳转。
 *
 * 挂在应用外壳上，任何页面都能唤出。菜单多起来之后，点两层侧边栏
 * 不如直接打两个字母。
 *
 * 选中项用 `aria-activedescendant` 而不是把焦点搬来搬去：
 * 焦点一旦离开输入框，用户想再改一个字母就得重新点回来。
 */
export function CommandPalette() {
  const {
    visible,
    close,
    query,
    onQueryChange,
    selected,
    setSelected,
    matches,
    onKeyDown,
    runAt,
  } = useCommandPalette();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [preferences] = usePreferences();
  const density = preferences.density;

  // 打开就聚焦：面板是键盘驱动的，多一次点击都是浪费。
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  // 键盘移动选中项时，把它滚进可视区 —— 结果多起来之后不滚就等于看不见。
  useEffect(() => {
    if (!visible) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [selected, visible]);

  if (!visible) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-6 pt-24 backdrop-blur-[2px]"
      onClick={close}
      role="presentation"
    >
      <div
        className="animate-pop-in flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl shadow-black/50"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3">
          <IconSearch className="shrink-0 text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面或连接，回车跳转"
            className="w-full bg-transparent py-3 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none"
            aria-label="搜索命令"
            aria-controls="command-list"
            aria-activedescendant={selected >= 0 ? `command-${selected}` : undefined}
            role="combobox"
            aria-expanded
          />
          <kbd className="shrink-0 rounded border border-slate-300 px-1 py-0.5 text-(length:--text-app-micro) text-slate-500">
            Esc
          </kbd>
        </div>

        <div id="command-list" ref={listRef} className="max-h-80 overflow-auto py-1" role="listbox">
          {matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-500">
              没有匹配的命令。先连一个集群，菜单才会出现。
            </p>
          ) : (
            matches.map((match, index) => (
              <CommandRow
                key={match.command.id}
                id={`command-${index}`}
                active={index === selected}
                group={showsGroup(matches, index) ? match.command.group : undefined}
                onHover={() => setSelected(index)}
                onClick={() => runAt(index)}
              >
                {match.command.title}
              </CommandRow>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-2 text-(length:--text-app-meta) text-slate-500">
          <span>↑↓ 选择 · 回车执行 · Esc 关闭</span>
          {/* 这里原来写「当前表格密度：紧凑 · ⌘K 开关」，让人以为能点。
              它只是一句状态说明，所以现在把「改密度」的入口明说出去。 */}
          <span className="truncate">
            密度：{DENSITY_OPTIONS.find((option) => option.value === density)?.label ?? "紧凑"}
            <span className="mx-1 text-meta">·</span>
            搜「密度」可改
          </span>
        </div>
      </div>
    </div>
  );
}

/** 同一组只在首项显示组名，否则每行都重复一遍连接名。 */
function showsGroup(matches: { command: { group: string } }[], index: number): boolean {
  if (index === 0) return true;
  return matches[index - 1].command.group !== matches[index].command.group;
}

function CommandRow({
  id,
  active,
  group,
  onHover,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  group?: string;
  onHover: () => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {group ? (
        <p className="px-4 pt-2 pb-1 text-(length:--text-app-meta) tracking-wider text-slate-500 uppercase">
          {group}
        </p>
      ) : null}
      <button
        type="button"
        id={id}
        role="option"
        aria-selected={active}
        data-active={active}
        // 用 mousemove 而不是 mouseenter：结果集变化（比如又打了一个字母）后
        // 鼠标没动，mouseenter 不会重触发，选中项就会停在鼠标之外的那一行。
        onMouseMove={onHover}
        onClick={onClick}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-4 py-1.5 text-left text-sm transition-colors",
          active
            ? "bg-selection font-medium text-slate-900"
            : "text-slate-600 hover:bg-slate-50",
        )}
      >
        <span className="truncate">{children}</span>
        {active ? <span className="text-(length:--text-app-meta) text-slate-500">↵</span> : null}
      </button>
    </>
  );
}
