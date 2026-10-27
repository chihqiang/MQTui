import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { IconAlert, IconRefresh } from "@/lib/icons";
import {
  progressBarVisible,
  refreshHintText,
  relativeTime,
  type RefreshState,
} from "@/lib/refresh";

import { Button } from "./button";

/**
 * 刷新按钮：把「点一下重新读」从各页手写的 `onClick={() => refetch()}` 收成一处。
 *
 * 三件事原来各页都做得不一样：
 * 1. 只有 `isLoading` 才转圈 —— `isFetching`（刷新）时按钮毫无反应，用户只能再点一次确认；
 * 2. 刷新时整页数字变灰 —— 一次刷新 200ms，闪一下会让人以为数据没了；
 * 3. 刷新之后没人知道数据是哪一刻的。
 *
 * 这三个状态都由 `describeRefresh` 决定，规则可测。
 */
export function RefreshButton({
  state,
  onRefresh,
  /** 最后一次成功读取的时间戳；给了就在旁边显示「N 分钟前」。 */
  updatedAt,
  size = "xs",
  label = "刷新",
  className,
}: {
  state: RefreshState;
  onRefresh: () => void;
  updatedAt?: number;
  size?: "xs" | "sm";
  label?: string;
  className?: string;
}) {
  const hint = refreshHintText(state, updatedAt ? relativeTime(updatedAt) : undefined);

  return (
    // 按钮自己带一根细进度线（见下）：全站 20 多处 `RefreshButton` 因此不必各接一遍。
    <span className={cn("relative flex min-w-0 items-center gap-2", className)}>
      <RefreshBar active={state.refreshing && state.hasData && !state.firstLoad} />
      {hint ? (
        <span className="truncate text-(length:--text-app-meta) text-meta" aria-live="polite">
          {hint}
        </span>
      ) : null}
      <Button
        size={size}
        variant="ghost"
        icon={<IconRefresh size={size === "xs" ? 11 : 13} />}
        loading={state.refreshing}
        onClick={onRefresh}
        aria-label={label}
      >
        {label}
      </Button>
    </span>
  );
}

/**
 * 刷新失败但手里还有旧数据时的提示条。
 *
 * 不用 `ErrorState` 顶掉内容：一次网络抖动不该把已经在手上的信息全收走。
 * 这条提示说清「看到的是旧数据」，并给一次重试入口 —— 而错误页把内容清空后，
 * 用户连「刚才那个数是多少」都没法回看。
 */
export function StaleNotice({
  message,
  onRetry,
  children,
}: {
  message: string;
  onRetry?: () => void;
  /** 额外说明，比如「下面是 3 分钟前读取的结果」。 */
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="animate-fade-in flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-(length:--text-app-body) text-warning"
    >
      <IconAlert size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 selectable">
        {message}
        {/* 70% 的告警色落在 10% 的同色底上，文字会跟着底一起褪 —— 补充说明降一档
            用中性色，反而是「主句是警告、括号里是补充」的正确层级。 */}
        {children ? <span className="text-secondary"> {children}</span> : null}
      </span>
      {onRetry ? (
        <Button size="xs" variant="ghost" onClick={onRetry} className="text-warning">
          重试
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 一条细进度线：不占高度，刷新时出现。
 *
 * 全站「正在刷新」的唯一信号本来是一个 11px 的旋转图标，一扫就漏 ——
 * 但把整片内容变灰更糟（那是 `refresh.tsx` 明确拒绝的做法）。
 * 折中的答案是一条 1px 的线：占位为零、不挪动任何内容、余光就能看到。
 *
 * 两处细节：
 * 1. 刷新可能在**一帧之内**结束，线会出现一下就消失。`progressBarVisible`
 *    给结束留了淡出窗口，避免在 60Hz 屏上闪成一道白光；
 * 2. 默认定位在父容器底边（`absolute`），父容器自己有 `h-px` 之类的高度时，
 *    它就成了「内容区顶部/底部的一条线」。不想绝对定位就传 `placement="flow"`。
 */
export function RefreshBar({
  active,
  placement = "overlay",
  className,
}: {
  active: boolean;
  /** `overlay`：绝对定位贴在父容器底边；`flow`：占一行 1px。 */
  placement?: "overlay" | "flow";
  className?: string;
}) {
  const [endedAt, setEndedAt] = useState<number | null>(null);
  // 结束之后还需要再渲染一次，让上面那行判断重新算一遍；`tick` 只是触发器。
  const [, setTick] = useState(0);
  const wasActive = useRef(false);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    // 刚结束：记下时刻，并在淡出窗口末尾再渲染一次，让线自己消失。
    wasActive.current = false;
    setEndedAt(Date.now());
    // 到淡出窗口末尾再渲染一次：那一次会让 `progressBarVisible` 返回 false，线自己消失。
    const timer = window.setTimeout(() => setTick((value) => value + 1), 260);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!progressBarVisible({ active, endedAt, now: Date.now() })) return null;

  return (
    <div
      aria-hidden
      className={cn(
        placement === "overlay"
          ? "pointer-events-none absolute inset-x-0 bottom-0 h-px"
          : "h-px w-full shrink-0",
        // 底色用品牌色而不是裸色号：这条线是「正在读」的语义，不是装饰。
        "animate-shimmer bg-linear-to-r from-transparent via-accent to-transparent bg-[length:200%_100%]",
        className,
      )}
    />
  );
}
