import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import {
  FILTER_DEBOUNCE_MS,
  filterChanged,
  filterFromParams,
  shouldCommitFilter,
  withFilter,
} from "@/lib/list-view";

/**
 * 列表页的过滤词：输入框跟本地草案走，去抖后落到 URL。
 *
 * 为什么过滤词要进 URL：它是「现场」的一部分。从列表点进详情再按返回，
 * 用 `useState` 存会回到一个空列表页，刚打的字白打了。
 *
 * 为什么还要在本地留一份草案：`useSearchParams` 在 `setParams` 之后要等
 * 一次完整的路由提交才会返回新的 params。原来输入框直接读 URL，于是每敲
 * 一个字都要「写 URL → 路由重渲染 → 读回新值 → 输入框才更新」——
 * 一个字符一次的额外提交，几万行的列表就是每敲一下卡一下；光标也容易被
 * 拽回末尾，中文输入法还会被打断。
 *
 * 现在：输入框立即响应，URL 延迟 `FILTER_DEBOUNCE_MS` 再写一次。
 * `replace: true` 保持不变 —— 每敲一个字都压一条历史记录的话，
 * 用户想退出列表页要按十几次返回。
 *
 * 还有一层：**打了又改回原样**（多按一下、纠正错字）时不再写 URL。
 * 这类空提交本身不改变任何东西，却会让整个列表页重渲染一次 —— 而它正是
 * 「打着字偶尔卡一下」里最常见的那次。判断在 `shouldCommitFilter` 中，
 * 跟着去抖窗口一起生效，所以不会漏掉真正想提交的那一次。
 */
export function useListFilter(key: string = "q"): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const committed = params.get(key) ?? "";
  const [draft, setDraft] = useState(committed);
  const timer = useRef<number | undefined>(undefined);
  // 路由返回的新值如果和当前输入框不一样（外部改了 URL、点了「清除过滤」旁边的链接），
  // 以 URL 为准 —— 但正在打字时不能覆盖，否则刚敲的字会被抹掉。
  const dirty = useRef(false);

  // 外部（URL）变化时对齐输入框。草案与已提交值不同说明用户还在打字，跳过。
  useEffect(() => {
    if (dirty.current) return;
    setDraft((current) => (filterChanged(current, committed) ? committed : current));
  }, [committed]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = useCallback(
    (next: string) => {
      dirty.current = false;
      // 与「URL 上的当前值」比较，而不是与上一次 commit 的参数比较：
      // 去抖期间 URL 可能已经被外部改过（点清除、按返回）。
      const current = new URLSearchParams(window.location.search).get(key) ?? "";
      if (!shouldCommitFilter({ draft: next, keyword: current })) return;
      // 用回调形式拿 params：去抖触发时闭包里那份可能是旧的，
      // 而列表页的 URL 上还有分页游标之类的参数，不能把它们冲掉。
      setParams(
        (current) => {
          const updated = withFilter(current, next);
          if (key !== "q") updated.delete("q");
          return updated;
        },
        { replace: true },
      );
    },
    [key, setParams],
  );

  const setKeyword = useCallback(
    (next: string) => {
      dirty.current = true;
      setDraft(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => commit(next), FILTER_DEBOUNCE_MS);
    },
    [commit],
  );

  return [draft, setKeyword];
}

/** 读取过滤词但不写回，用于只需要回显的场景。 */
export function useFilterValue(): string {
  const [params] = useSearchParams();
  return filterFromParams(params);
}
