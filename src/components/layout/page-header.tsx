import type { ReactNode } from "react";

/**
 * 页面标题头：一句话说清「这是哪、能干什么」，右侧放本页的主操作。
 *
 * 原来每个页面各写一套 `<h1 className="...">` + 说明，字号和间距各不相同；
 * 收到一个组件里之后，页面之间翻动时标题位置不会来回跳。
 */
export function PageHeader({
  title,
  description,
  actions,
  /** 标题左侧的返回入口，详情页用。 */
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {back}
      <div className="min-w-0 flex-1">
        {/* 标题走 `display` 档（16px）。原来是 14px，和表头只差 3px、和正文差 2px，
            页头在视觉上不承担「你现在在哪」的职责。 */}
        <h1 className="flex items-center gap-2 truncate text-(length:--text-app-display) leading-6 font-semibold tracking-tight text-slate-100">
          {title}
        </h1>
        {description ? (
          <p className="mt-0.5 truncate text-(length:--text-app-meta) text-slate-400">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * 列表页的过滤条：左边过滤框 + 一句「共多少条、命中多少」，右边主操作。
 *
 * 列表页顶部原本是三份手抄的 flex 布局，间距与对齐各不相同（有的 `items-center`
 * 有的 `items-end`），翻页时按钮会跟着跳一两像素。收到一处之后，横向位置固定下来。
 */
export function PageToolbar({
  children,
  hint,
  actions,
}: {
  /** 过滤框等左侧控件。 */
  children?: ReactNode;
  /** 计数说明，放在控件右侧，不换行。 */
  hint?: ReactNode;
  /** 右侧主操作。 */
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {children}
      {hint ? <p className="min-w-0 truncate text-xs text-slate-400">{hint}</p> : null}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * 页面滚动容器：统一内边距与纵向节奏。
 *
 * `h-full` + `overflow-auto` 的两层结构在 20 多个页面里重复出现过，
 * 写法一旦不一致就会出现「只有半页能滚」这种难查的毛病。
 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex h-full flex-col gap-3 overflow-auto p-4 ${className ?? ""}`}>
      {children}
    </div>
  );
}

/**
 * 仪表盘页面的外壳：页头固定，内容区自己滚。
 *
 * 和 `PageBody` 的差别只有一句：页头不参与滚动。列表页滚动时表头跟着走没关系
 * （内容本来就长），但仪表盘滚起来的第一屏就是全部内容，页头一滚，用户就
 * 不知道自己在看哪个集群了。
 */
export function PageFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex h-full min-h-0 flex-col gap-3 p-4 ${className ?? ""}`}>{children}</div>
  );
}
