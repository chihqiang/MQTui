import { useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode, type TdHTMLAttributes } from "react";

import { cn } from "@/lib/cn";
import { IconSpinner } from "@/lib/icons";
import { densityRowPadding } from "@/lib/list-view";
import { isRestorable, type ScrollMemory } from "@/lib/scroll-restore";
import { usePreferences } from "@/hooks/use-preferences";
import { RefreshBar } from "./refresh";
import { Skeleton } from "./skeleton";

/**
 * 表格原语。
 *
 * 面板里 20 多张表原本各写一套 `thead`（`text-(length:--text-app-meta) uppercase tracking-wide text-slate-500`
 * 这一段抄了 20 遍），改一次列间距要翻 20 个文件。这里把「表头长相」定死一处，
 * 页面只描述「有哪些列、每列多宽、怎么对齐」。
 *
 * 列宽与对齐写在列定义里而不是单元格上：列是表格的属性，不是某一格的心情。
 */

export interface DataTableColumn {
  key: string;
  label?: ReactNode;
  /** Tailwind 宽度类（`w-8` / `w-32`）；不写就按内容自适应。 */
  width?: string;
  align?: "left" | "right" | "center";
}

const ALIGN_CLASS = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
} as const;

export function DataTable({
  columns,
  children,
  className,
  /** 首屏加载：画骨架行而不是转圈，数据到位时列宽不跳。 */
  loadingRows,
  refreshing = false,
  /** 列多的表在窄窗口下会撑破卡片，统一让容器横滚。 */
  scrollable = true,
  /** 表头吸顶：只有内部自己滚动的表格用得上，页面级滚动时吸顶会跟着飘。 */
  stickyHeader = false,
  /** 位置记忆的键：填了就记住本表的滚动位置，卸载后重新挂载可回到原处。 */
  scrollKey,
  /** 记忆表由调用方持有，跨挂载存活。 */
  scrollMemory,
}: {
  columns: DataTableColumn[];
  /** 数据行；首屏骨架时可以不传。 */
  children?: ReactNode;
  className?: string;
  loadingRows?: number;
  refreshing?: boolean;
  scrollable?: boolean;
  stickyHeader?: boolean;
  scrollKey?: string;
  scrollMemory?: ScrollMemory;
}) {
  // 行高由偏好决定，两档全站一致 —— 表头、骨架、数据行共用同一个值。
  const [preferences] = usePreferences();

  const table = (
    // 行内边距以 CSS 变量下发：单元格只写一次 `py-(--row-py)`，不各自读偏好。
    // 换密度只重渲染一次 `<table>`，而不是让每个单元格各触发一遍更新。
    <table
      className={cn("w-full text-left", className)}
      aria-busy={refreshing || undefined}
      style={{ "--row-py": densityRowPadding(preferences.density) } as CSSProperties}
    >
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cn(
                "border-b border-slate-800 px-4 text-(length:--text-app-meta) font-normal tracking-wide uppercase",
                "text-slate-500 select-none",
                // 吸顶时必须有底色：半透明表头滚过内容会糊成一片。
                stickyHeader && "sticky top-0 z-10 bg-slate-900",
                "py-(--row-py)",
                column.width,
                ALIGN_CLASS[column.align ?? "left"],
              )}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {loadingRows ? (
          <SkeletonRows columns={columns} rows={loadingRows} />
        ) : (
          children
        )}
      </tbody>
    </table>
  );

  // 进度线挂在表格外层：横滚容器一旦横向滚动，粘在里面的线会跟着跑。
  const body = (
    <div className="relative">
      {table}
      <RefreshBar active={refreshing} />
    </div>
  );

  if (!scrollable) return body;
  // 横滚容器顺带记住纵向位置：列表页点进详情再返回，人不用重新滚一遍。
  // 用 `<ScrollRestore>` 包起来而不是在这里再写一遍 ref/effect。
  return (
    <ScrollRestore scrollKey={scrollKey} scrollMemory={scrollMemory} className="w-full overflow-x-auto">
      {body}
    </ScrollRestore>
  );
}

/**
 * 一个能记住自己滚动位置的容器。
 *
 * 页面里绝大多数「点了详情再返回，位置丢了」的容器都是这一种形状：`overflow-auto`
 * + 内容由查询数据决定。记忆放在调用方持有的 `Map` 里（页面级 ref），
 * 容器卸载后数据仍在，重新挂载时先按记忆定位再绘制，看不到跳动。
 */
function ScrollRestore({
  scrollKey,
  scrollMemory,
  className,
  children,
}: {
  scrollKey?: string;
  scrollMemory?: ScrollMemory;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!scrollKey || !scrollMemory) return;
    const element = ref.current;
    if (!element) return;
    const desired = scrollMemory.get(scrollKey);
    if (desired === undefined) return;
    element.scrollTop = Math.min(desired, Math.max(element.scrollHeight - element.clientHeight, 0));
  }, [scrollKey, scrollMemory]);

  return (
    <div
      ref={ref}
      className={className}
      onScroll={
        scrollKey && scrollMemory
          ? (event) => {
              const top = event.currentTarget.scrollTop;
              if (isRestorable(top)) scrollMemory.set(scrollKey, top);
              else scrollMemory.delete(scrollKey);
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

function SkeletonRows({
  columns,
  rows,
}: {
  columns: DataTableColumn[];
  rows: number;
}) {
  return Array.from({ length: rows }, (_, rowIndex) => (
    <tr key={`skeleton-${rowIndex}`} className="border-b border-slate-800/40 last:border-0">
      {columns.map((column, columnIndex) => (
        <td
          key={column.key}
          className={cn("px-4 py-(--row-py)", ALIGN_CLASS[column.align ?? "left"])}
        >
          <Skeleton
            className={cn("h-4", (column.align ?? "left") === "right" && "ml-auto")}
            // 错开的宽度让骨架看起来像真数据，不像一排整齐的灰条。
            style={{ width: `${68 - ((rowIndex + columnIndex) % 3) * 14}%` }}
          />
        </td>
      ))}
    </tr>
  ));
}

/** 行：`clickable` 只在真能点开时打开，否则是「看着能点、点了没反应」。 */
export function TableRow({
  className,
  clickable = false,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return (
    <tr
      className={cn(
        "border-b border-slate-800/60 last:border-0",
        // 只有真能点开的行才给手型与悬停底色，否则是「看着能点、点了没反应」。
        clickable && "cursor-pointer transition-colors hover:bg-slate-800/40",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  mono = false,
  muted = false,
  numeric = false,
  align,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & {
  mono?: boolean;
  muted?: boolean;
  /** 数字列：右对齐 + 等宽数字，扫一列位点时不会左右跳。 */
  numeric?: boolean;
  /** 与列定义同名的对齐；数字列默认右对齐，不必重复写。 */
  align?: "left" | "right" | "center";
}) {
  const resolved = align ?? (numeric ? "right" : undefined);
  return (
    <td
      className={cn(
        "px-4",
        // 行内边距从 `<td>` 上的 CSS 变量取，不再订阅偏好：
        // 一行一个 `usePreferences()`，一屏 30 行就是 30 个订阅，
        // 而它们 99% 的时间在算同一个值 —— 换密度时全站几百个单元格一起触发更新。
        // `DataTable` 把档位写在 `<table>` 的变量上，行只是消费者。
        "py-(--row-py)",
        mono && "font-mono text-xs",
        muted && "text-slate-400",
        numeric && "tabular",
        resolved && ALIGN_CLASS[resolved],
        className,
      )}
      {...props}
    />
  );
}

/** 行尾的动作区：永远右对齐，按钮不换行。 */
export function TableActions({ className, style, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      style={style}
      className={cn("flex items-center justify-end gap-1.5 whitespace-nowrap", className)}
      {...props}
    />
  );
}

/**
 * 列表还有下一页时的提示。
 *
 * 虚拟列表本身就靠「往下滚、自动续读」，所以这里不做按钮，只留一条细指示：
 * 有下一页时给转圈，翻到底时给一句「已到尽头」，两类状态都由 `Fragment` 占位，不撑高布局。
 */
export function ListFooter({
  hasMore,
  loading,
  className,
}: {
  hasMore: boolean;
  loading: boolean;
  className?: string;
}) {
  if (!hasMore && !loading) return null;
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-1.5 py-1.5 text-(length:--text-app-meta) text-slate-500",
        className,
      )}
      role="status"
    >
      {loading ? (
        <>
          <IconSpinner className="animate-spin" size={12} />
          正在读取…
        </>
      ) : (
        "继续向下滚动读取更早的消息"
      )}
    </div>
  );
}
