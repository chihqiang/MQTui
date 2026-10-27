/**
 * 会话状态：当前选中的连接 + toast 通知 + 虚拟列表的全局 UI 状态。
 *
 * 仅存放「跨页面共享且非服务端数据」的状态；服务端数据一律交给 React Query。
 */

import { create } from "zustand";

import type { BrokerKind } from "@/types";

export interface Toast {
  id: string;
  kind: "success" | "error" | "info";
  message: string;
}

interface SessionState {
  /** 当前选中的连接 ID，null 表示停留在连接选择页。 */
  activeConnectionId: string | null;
  toasts: Toast[];
  setActiveConnection: (id: string | null) => void;
  pushToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  activeConnectionId: null,
  toasts: [],
  setActiveConnection: (id) => set({ activeConnectionId: id }),
  pushToast: (kind, message) =>
    set((state) => ({
      toasts: [...state.toasts, { id: crypto.randomUUID(), kind, message }],
    })),
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/** 记住连接成功后最近使用的连接（仅非敏感信息）。 */
export interface RecentConnectionMeta {
  kind: BrokerKind;
  endpoint: string;
}
