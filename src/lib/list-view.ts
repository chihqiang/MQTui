/**
 * 列表页的视图状态：密度档位、过滤词与 URL 的往返。
 *
 * 抽成纯函数的原因是这两件事都很容易做反，而且做反了不报错：
 *
 * 1. **过滤词不进 URL**：从主题列表点进详情、再按返回，过滤词没了 ——
 *    用户得重新打一遍刚打过的字。这不是"小瑕疵"，是每次进详情都要付一次税。
 * 2. **密度只能全站一致**：表格行高在大表格里写死，一页紧凑一页宽松，
 *    翻页面时视线要重新适应，跟"更快"正好相反。
 */

/** 行密度：紧凑档把一屏的行数提上去，宽松档给长名称更多呼吸。 */
export type Density = "compact" | "comfortable";

export const DENSITY_OPTIONS: { value: Density; label: string; hint: string }[] = [
  { value: "compact", label: "紧凑", hint: "行高最小，一屏信息最多" },
  { value: "comfortable", label: "宽松", hint: "行高更大，适合长时间阅读" },
];

export const DEFAULT_DENSITY: Density = "compact";

export function isDensity(value: unknown): value is Density {
  return value === "compact" || value === "comfortable";
}

/**
 * 行内边距与字号的类名。
 *
 * 只有两档，且宽度/对齐仍由列定义决定 —— 密度只改纵向节奏。
 */
export function densityRowClass(density: Density): string {
  return density === "compact" ? "py-1.5" : "py-2.5";
}

/**
 * 行内边距的 CSS 值（不是类名）。
 *
 * 表格把它写成 `--row-py` 变量挂在 `<table>` 上，单元格只需 `py-(--row-py)`。
 * 这么做是为了让「换密度」只改一处，而不是让每个单元格各自订阅偏好。
 * 两个值与 `densityRowClass` 必须一致 —— 所以由一个映射推导，不各写一遍。
 */
export const ROW_PADDING_PX: Record<Density, string> = {
  compact: "0.375rem", // py-1.5
  comfortable: "0.625rem", // py-2.5
};

export function densityRowPadding(density: Density): string {
  return ROW_PADDING_PX[density];
}

/**
 * 两档密度对应的行高（px）。
 *
 * 虚拟列表必须知道准确的行高才能算偏移量，而这个数字原来在页面里写死成 34 ——
 * 于是一换到「宽松」档，行就被画矮了：越往下滚，列表内容相对滚动位置偏得越多，
 * 鼠标滚一格，视线落点跳一大截。行高和行内边距必须是同一个来源。
 *
 * 数值 = `densityRowClass` 的上下内边距 + 一行文字的盒子：紧凑 34、宽松 42。
 */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  compact: 34,
  comfortable: 42,
};

export function densityRowHeight(density: Density): number {
  return DENSITY_ROW_HEIGHT[density];
}

/** URL 里承载过滤词的参数名。 */
export const FILTER_PARAM = "q";

/**
 * 过滤框的当前值。
 *
 * 空串等于没有条件；这里刻意不 `trim` 后回写 —— 用户在打「order 1」时
 * 中间那个空格要留在输入框里，否则光标会自己往回跳。
 */
export function filterFromParams(params: URLSearchParams): string {
  return params.get(FILTER_PARAM) ?? "";
}

/**
 * 把过滤词写回查询串，返回新的 `URLSearchParams`。
 *
 * 输入是 `URLSearchParams` 而不是字符串，是因为列表页还有别的参数（分页游标等），
 * 逐个拼字符串早晚会把这些参数冲掉。
 *
 * 空值时删掉该参数：地址栏里留一个 `?q=` 会让人以为过滤生效了。
 */
export function withFilter(params: URLSearchParams, keyword: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const trimmed = keyword.trim();
  if (trimmed) next.set(FILTER_PARAM, keyword);
  else next.delete(FILTER_PARAM);
  return next;
}

/**
 * 过滤是否真的改变了 —— 用来决定「要不要写入历史」。
 *
 * 只要值不同就返回 true；相同则 false。这层判断在页面里写会变成
 * `if (a !== b)` 满天飞，而漏一次就会在历史里堆一串空记录，
 * 用户按返回要按十几次才能退出一个列表页。
 */
export function filterChanged(previous: string, next: string): boolean {
  return previous !== next;
}

/**
 * 过滤框的「边打边筛」要延迟多久再落到 URL 上。
 *
 * 每个按键都写一次 URL 的代价不只是 history：`useSearchParams` 一变，
 * 整个列表页跟着重渲染，几万行的列表就是每敲一个字卡一下。
 * 120ms 是手速下限（差不多是一次连击的间隔），比它更短等于没延迟，
 * 更长（300ms）就会让人觉得「软件没反应」。
 */
export const FILTER_DEBOUNCE_MS = 120;

/** 去抖是否该触发：只在草案与已提交值不同时才写 URL，避免空转。 */
export function shouldCommitFilter({
  draft,
  keyword,
}: {
  draft: string;
  keyword: string;
}): boolean {
  return filterChanged(keyword, draft);
}

/**
 * 虚拟列表的滚动重渲染节流（毫秒）。
 *
 * 虚拟列表每次滚动都要 `setState` 重算可见区间。滚轮一格的间隔可以到 8ms，
 * 逐帧重渲染几万条数据的切片时，主线程被占满，滚轮事件就排在后面 ——
 * 表现就是「滚一下顿一下」。一帧（16ms）之内至多重算一次，肉眼看不出差别。
 */
export const SCROLL_THROTTLE_MS = 16;

/**
 * 节流器：立即返回是否应该执行。
 *
 * 纯逻辑难测时间，所以把「上一次执行的时间戳」交给调用方持有，
 * 这里只做判断 —— 这样单测里给两个时间戳就能验完。
 */
export function shouldRunThrottled(lastRunAt: number, now: number, interval = SCROLL_THROTTLE_MS): boolean {
  return now - lastRunAt >= interval;
}

/**
 * 候选 chip 的「显示几个 + 还剩几个」。
 *
 * 消息页的候选（最近看过的 topic / queue + 当前列表）原来一刀切只取前 6 个，
 * 超出的**连提都不提** —— 用户不知道还有第 7 个候选，只能回去手打。
 * 现在改成：留一格给「更多」入口，其余平铺。
 *
 * `slot` 是给「更多」按钮预留的位置（0 表示溢出项就地折进菜单、不额外占位）。
 * 上限很小时优先保证「看得全」：宁可少显示一个候选，也要让「还有更多」可见。
 */
export function chipOverflow(total: number, max: number, slot = 0): {
  /** 平铺显示的候选个数。 */
  visible: number;
  /** 收进「更多」的候选个数；0 表示不显示「更多」。 */
  hidden: number;
} {
  if (total <= 0 || max <= 0) return { visible: 0, hidden: 0 };
  if (total <= max) return { visible: total, hidden: 0 };
  // 溢出时必须给「更多」留得住一格；留不住就整体按 max 显示，「更多」就地折叠。
  const visible = slot > 0 && max > 1 ? max - slot : max;
  return { visible, hidden: total - visible };
}
