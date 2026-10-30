import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes } from "react";

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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

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

  // 高亮的候选要跟着滚动：候选区是定高滚动的，键盘往下按到第 20 条时，
  // 高亮跑到可视区外就等于「按了没反应」。
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-choice-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (next: string) => {
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
      onBlur={(event) => {
        if (rootRef.current?.contains(event.relatedTarget as Node | null)) return;
        settle();
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
          className={cn(
            "absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white py-1",
            "shadow-lg shadow-slate-900/10",
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
                onClick={() => commit(item.value)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-(length:--text-app-body) transition-colors",
                  index === active ? "bg-indigo-50 text-indigo-900" : "text-slate-800",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{item.value}</span>
                {item.hint ? (
                  <span className="shrink-0 text-(length:--text-app-meta) text-slate-500">
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
