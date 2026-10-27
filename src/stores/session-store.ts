/**
 * 会话状态：toast 通知。
 *
 * 仅存放「跨页面共享且非服务端数据」的状态；服务端数据一律交给 React Query。
 *
 * 「当前选中的连接」曾经也在这里，后来搬去了 URL（见 `useActiveConnection`）。
 * 原因很简单：它是一份由路由派生出来的副本，而副本会落后 —— 同步它的
 * `useEffect` 只挂在索引路由上，从连接页直接点进「发送消息」就绕过了它，
 * 于是页面一边连着一边说「先选一个连接」。路由参数本身没有这个问题。
 */

import { create } from "zustand";

import type { BrokerKind } from "@/types";

export interface Toast {
  id: string;
  /** `progress` 表示「正在进行、尚未有结果」，不会自动消失，由发起方主动替换。 */
  kind: "success" | "error" | "info" | "progress";
  message: string;
}

interface SessionState {
  toasts: Toast[];
  pushToast: (kind: Toast["kind"], message: string) => string;
  dismissToast: (id: string) => void;
  /** 就地替换一条提示，用于把「进行中」收尾成「成功 / 失败」。 */
  updateToast: (id: string, kind: Toast["kind"], message: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  toasts: [],
  pushToast: (kind, message) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    // 返回 id，调用方可以拿它把「进行中」换成「已完成」，而不是再堆一条。
    return id;
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  updateToast: (id, kind, message) =>
    set((state) => ({
      toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, kind, message } : toast)),
    })),
}));

/** 记住连接成功后最近使用的连接（仅非敏感信息）。 */
export interface RecentConnectionMeta {
  kind: BrokerKind;
  endpoint: string;
}
