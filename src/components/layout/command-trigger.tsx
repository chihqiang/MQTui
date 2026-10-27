import { isMacPlatform } from "@/lib/command-palette";
import { IconSearch } from "@/lib/icons";
import { useCommandStore } from "@/stores";

/**
 * 命令面板的发现入口。
 *
 * 快捷键只有知道的人才会用，所以顶部栏放一个可见的按钮，
 * 上面写着当前平台的组合键 —— 让「有这个东西」这件事可见。
 *
 * 宽度不写满：它现在是顶部栏里的一项，不是侧边栏的一条横幅。
 */
export function CommandTrigger() {
  const open = useCommandStore((state) => state.open);
  // 平台判断只影响文案，读一次即可。
  const shortcut = isMacPlatform() ? "⌘K" : "Ctrl K";

  return (
    <button
      type="button"
      onClick={open}
      className="flex w-56 min-w-0 items-center gap-1.5 rounded border border-slate-800 px-2 py-1 text-(length:--text-app-meta) text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-800/60 hover:text-slate-200"
      aria-label="打开命令面板"
    >
      <IconSearch size={12} />
      <span className="flex-1 truncate text-left">搜索 / 跳转</span>
      <kbd className="rounded border border-slate-700 px-1 text-(length:--text-app-micro) text-slate-500">
        {shortcut}
      </kbd>
    </button>
  );
}
