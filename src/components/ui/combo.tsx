import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";
import { dedupeChoices, filterChoices, stepChoice, type ChoiceList } from "@/lib/choice";
import { IconChevronDown } from "@/lib/icons";
import { FIELD_CLASS, NO_TEXT_ASSIST } from "@/components/ui/input";

/**
 * 把 `onKeyDown` 摘出去。
 *
 * 调用方的 `onKeyDown` 必须在方向键、回车之后才轮到它 —— 「先给下拉让路，再交回原处」。
 * 挂在 `...props` 里会被下面手写的那个覆盖掉，于是调用方的处理默默消失；
 * 这里显式摘掉，改成在手写的处理里主动调用。
 */
function omitOnKeyDown<T extends { onKeyDown?: unknown }>(props: T): Omit<T, "onKeyDown"> {
  const { onKeyDown: _ignored, ...rest } = props;
  return rest;
}

/** 候选面板的最大高度，与 `max-h-64` 对齐。 */
const PANEL_MAX_HEIGHT = 256;
/** 面板至少要有这么宽：窄栏里（发送页右栏）候选名 + 说明挤在 100px 内谁都读不出来。 */
const PANEL_MIN_WIDTH = 256;
/** 面板与输入框之间的缝。 */
const PANEL_GAP = 8;

/**
 * 这个元素实际能被看到的四周边界。
 *
 * 不能只看 `window.innerHeight`：工作区的外壳（`PageBody`）自己就是一个
 * `overflow-auto` 的滚动盒，候选面板超出它的部分会被裁掉 —— 看上去还在，
 * 点下去却什么都没发生。所以沿祖先链把所有「会裁剪的盒子」都收进来。
 */
function visibleBounds(element: HTMLElement): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  let top = 0;
  let left = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clipsY = style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "hidden";
    const clipsX = style.overflowX === "auto" || style.overflowX === "scroll" || style.overflowX === "hidden";
    if (!clipsY && !clipsX) continue;
    const rect = node.getBoundingClientRect();
    if (clipsY) {
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    if (clipsX) {
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
    }
  }
  return { top, right, bottom, left };
}

/**
 * 可输入的下拉：候选摊开，但键盘照样能敲出列表里没有的名字。
 *
 * 为什么不用 `<datalist>`：它满足「手输 + 候选」这个需求，但满足得很勉强 ——
 * 候选项由浏览器自己画，颜色字号跟随系统（和我们这套浅色语义变量不是一回事），
 * Safari 上点箭头干脆什么都不弹；更麻烦的是候选**必须**匹配输入内容，
 * 于是「我刚从别的页面看到某个队列名，但记不全」这种最常见的场景它帮不上忙。
 *
 * 相对 `<Select>` 的取舍：下拉只能选已有的，而这个仓库里到处都是「名字由服务端在建的时候起，
 * 客户端不该替它决定合法集合」（新建主题、新建绑定、发一条到还没消费的 topic）。
 * 所以默认「既可点，也可敲」，真的要限制取值时调用方传 `strict`。
 *
 * 三个行为上的决定：
 * 1. **点箭头弹全量，聚焦不弹**。聚焦就弹一张盖住下面的面板，是这种控件最烦人的地方；
 *    而箭头是明确的「我要看看有什么」。
 * 2. **空输入时先给「最近」**。候选顺序由调用方定，最近用过的排前面，这一屏就够点。
 * 3. **回车只在下拉里选中的时候接管**，否则表单该提交就提交 —— 手输一个不在列表里的名字
 *    之后按回车，用户期待的是「发出去」，不是「把高亮那条覆盖上来」。
 */

export function ComboInput({
  value,
  onValueChange,
  choices,
  className,
  strict = false,
  allowEmpty = false,
  placeholder,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "list"> & {
  value: string;
  onValueChange: (next: string) => void;
  choices: ChoiceList;
  /** 只允许取候选里的值：失焦或回车时把不合法的输入退回原样。 */
  strict?: boolean;
  /** 允许留空。`strict` 下不加这一条，空串会被当成非法值弹回去。 */
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 失焦收口的延时器，见 `onBlur` 上的注释。 */
  const settleTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /**
   * 面板往哪边弹、最高多少。
   *
   * 一直往下弹在页面底部（发送页右栏、表格最后一行）会把一半候选送到可视区外：
   * 被滚动盒裁掉的那几条既看不见，也点不到 —— 看起来就是「推荐项点不动」。
   * 所以每次打开先量一次上下余量，下面不够就翻到输入框上方。
   */
  const [panel, setPanel] = useState({
    up: false,
    alignRight: false,
    maxHeight: PANEL_MAX_HEIGHT,
    width: PANEL_MIN_WIDTH,
  });

  const options = useMemo(() => dedupeChoices(choices), [choices]);
  const visible = useMemo(() => filterChoices(options, value), [options, value]);
  // 没有候选时完全不挂面板：空壳下拉点开是一块白框，比什么都不弹更让人困惑。
  const enabled = options.length > 0;

  // 点到别处就收起。用 `pointerdown` 而不是 `click`：点击落点若是另一个输入框，
  // 等到 click 时焦点已经移走，面板会短暂盖在别人身上再消失。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 打开之后再量：面板没渲染时量不到真实高度（候选行数随过滤结果变）。
  useLayoutEffect(() => {
    if (!open || !enabled) return;
    const root = rootRef.current;
    const list = listRef.current;
    if (!root || !list) return;
    const rect = root.getBoundingClientRect();
    const bounds = visibleBounds(root);

    const spaceBelow = bounds.bottom - rect.bottom - PANEL_GAP;
    const spaceAbove = rect.top - bounds.top - PANEL_GAP;
    const wanted = Math.min(list.scrollHeight, PANEL_MAX_HEIGHT);
    const up = spaceBelow < wanted && spaceAbove > spaceBelow;
    // 翻上去只是换个方向，高度还得压进那一边的余量里 —— 否则照样被裁掉。
    const maxHeight = Math.max(96, Math.min(PANEL_MAX_HEIGHT, up ? spaceAbove : spaceBelow));

    // 宽度：窄输入框（发送页右栏的 header 名）撑不到能读，给一个下限；
    // 往右张开会撞到裁剪盒右边缘时改成贴右边、向左展开。
    const width = Math.max(rect.width, PANEL_MIN_WIDTH);
    const widthLimit = Math.max(160, bounds.right - bounds.left - PANEL_GAP * 2);
    const finalWidth = Math.min(width, widthLimit);
    const alignRight = rect.left + finalWidth > bounds.right;

    setPanel((previous) =>
      previous.up === up &&
      previous.alignRight === alignRight &&
      previous.maxHeight === maxHeight &&
      previous.width === finalWidth
        ? previous
        : { up, alignRight, maxHeight, width: finalWidth },
    );
  }, [open, enabled, visible.length]);

  // 高亮的候选要跟着滚动：候选区是定高滚动的，键盘往下按到第 20 条时，
  // 高亮跑到可视区外就等于「按了没反应」。
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-choice-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (next: string) => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    onValueChange(next);
    setOpen(false);
    setActive(-1);
    // 点选之后把焦点还给输入框：接着按 Tab 就能去下一格，而不是从文档头重新开始。
    inputRef.current?.focus();
  };

  /**
   * 失焦时收口：`strict` 下把非法输入退回最近的合法值。
   *
   * 非法输入**直接清空**，不「帮你选第一个」：下拉被人一打开就自动填上第一个 topic，
   * 看着像功能，实际是替人做了一个他不知道的选择。空着至少是诚实的 ——
   * 页面上那些「必填」与「先填条件」的提示会接着说话。
   */
  const settle = () => {
    setOpen(false);
    setActive(-1);
    if (!strict || (value.trim() === "" && allowEmpty)) return;
    if (options.some((item) => item.value === value.trim())) return;
    if (value !== "") onValueChange("");
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onFocus={() => {
        // 焦点又回来了（点了候选之后 `commit` 会把焦点还给输入框）：取消待收口。
        if (settleTimer.current !== null) {
          window.clearTimeout(settleTimer.current);
          settleTimer.current = null;
        }
      }}
      onBlur={(event) => {
        if (rootRef.current?.contains(event.relatedTarget as Node | null)) return;
        // 不能立刻收口：WebKit（macOS 的 WKWebView，也就是这个应用）点按钮
        // **不会**把焦点移过去，`relatedTarget` 是 null，于是失焦先发生、
        // 面板先被拆掉，紧接着的 click 落在一个已经不存在的节点上 ——
        // 表现就是「候选看得见、点不动」。推迟一帧，让 click 先跑完。
        settleTimer.current = window.setTimeout(() => {
          settleTimer.current = null;
          settle();
        }, 0);
      }}
    >
      <input
        ref={inputRef}
        // 候选名是服务端起的（主题、队列、routing key）：首字母被自动大写就不是同一个名字了。
        {...NO_TEXT_ASSIST}
        // 调用方的 `onKeyDown` 在下面手写调用：必须先给 ↑↓ / Enter / Esc 让路，
        // 再交回去，否则输入框一响应方向键，高亮就跳回第一条。
        {...omitOnKeyDown(props)}
        value={value}
        placeholder={placeholder}
        className={cn(FIELD_CLASS, "pr-7", className)}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        onChange={(event) => {
          onValueChange(event.currentTarget.value);
          // 打字就把列表打开：此刻的候选是「匹配当前输入的那几条」，正是想要的。
          if (enabled) {
            setOpen(true);
            setActive(-1);
          }
        }}
        onKeyDown={(event) => {
          if (enabled && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              setActive(stepChoice(-1, event.key === "ArrowDown" ? 1 : -1, visible.length));
            } else {
              setActive(stepChoice(active, event.key === "ArrowDown" ? 1 : -1, visible.length));
            }
            return;
          }
          if (open && event.key === "Enter" && active >= 0) {
            event.preventDefault();
            const picked = visible[active];
            if (picked) commit(picked.value);
            return;
          }
          if (event.key === "Escape" && open) {
            // 只收面板，不冒泡：位点重置这类页面把 Esc 留给了「放弃本次操作」，
            // 但在下拉打开时先说清「我要关的是这个列表」。
            event.stopPropagation();
            setOpen(false);
            setActive(-1);
            return;
          }
          if (open && event.key === "Tab") setOpen(false);
          props.onKeyDown?.(event);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        disabled={props.disabled || !enabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          inputRef.current?.focus();
          setOpen(true);
          setActive(-1);
        }}
        className={cn(
          "absolute top-0 right-0 bottom-0 flex w-7 items-center justify-center rounded-r-lg",
          "text-meta transition-colors",
          enabled && !props.disabled ? "hover:text-slate-700" : "opacity-40",
        )}
      >
        <IconChevronDown size={12} />
      </button>

      {open && enabled ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          style={{ maxHeight: panel.maxHeight, width: panel.width }}
          className={cn(
            "absolute z-30 overflow-auto rounded-lg border border-slate-200 bg-white py-1",
            "shadow-lg shadow-slate-900/10",
            panel.up ? "bottom-full mb-1" : "top-full mt-1",
            panel.alignRight ? "right-0" : "left-0",
          )}
        >
          {visible.length === 0 ? (
            <p className="px-2.5 py-1.5 text-(length:--text-app-body) text-slate-500">
              没有匹配的候选，回车即使用手输的名字
            </p>
          ) : (
            visible.map((item, index) => (
              <button
                key={item.value}
                id={`${listId}-${index}`}
                data-choice-index={index}
                type="button"
                role="option"
                aria-selected={item.value === value}
                onMouseEnter={() => setActive(index)}
                // WebKit 里按钮默认不在 mousedown 时获得焦点，`preventDefault()`
                // 让浏览器连「失焦」这一步都别做 —— 输入框一直是焦点，
                // 面板就不会在 click 之前被收掉。
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(item.value)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-(length:--text-app-body) transition-colors",
                  index === active ? "bg-indigo-50 text-indigo-900" : "text-slate-800",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{item.value}</span>
                {item.hint ? (
                  <span className="max-w-[55%] shrink-0 truncate text-(length:--text-app-meta) text-slate-500">
                    {item.hint}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
