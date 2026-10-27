import { useEffect, useState } from "react";

import { relativeTime } from "@/lib/refresh";

/**
 * 「数据更新于 N 秒前」。
 *
 * 面板里的数字会迅速过期：滞后量、堆积量、消费者数三分钟前是 0，现在可能已经上万。
 * 所以时间戳本身比刷新按钮更有用 —— 它让人知道「要不要动手刷」。
 *
 * 用一个连接级的节拍重渲染，而不是给每处文案各挂一个定时器：
 * 一个页面只有一个「最近读取时间」，一个定时器就够。
 *
 * 间隔 5 秒是折中：`relativeTime` 最小档是「10 秒以内 = 刚刚」，
 * 5 秒的刷新粒度足以让「刚刚 → 12 秒前」及时出现，又不至于每秒重渲染。
 */
export function useFreshness(updatedAt: number, pending: boolean): string {
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 5_000);
    return () => clearInterval(timer);
  }, []);

  if (pending) return "读取中…";
  // `dataUpdatedAt` 为 0 表示这一轮还没成功读到过，不给时间戳比给「1970 年」好。
  if (!updatedAt) return "";
  return relativeTime(updatedAt);
}
