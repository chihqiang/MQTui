/**
 * 会话状态：当前选中的连接 + toast 通知 + 虚拟列表的全局 UI 状态。
 *
 * 仅存放「跨页面共享且非服务端数据」的状态；服务端数据一律交给 React Query。
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
  /** 当前选中的连接 ID，null 表示停留在连接选择页。 */
  activeConnectionId: string | null;
  toasts: Toast[];
  /** 命令面板的搜索词。放在 store 里是为了让快捷键 handler 与输入框共享同一份状态。 */
  commandQuery: string;
  /** 命令面板当前选中的序号，-1 表示无结果。 */
  commandSelection: number;
  setActiveConnection: (id: string | null) => void;
  pushToast: (kind: Toast["kind"], message: string) => string;
  dismissToast: (id: string) => void;
  /** 就地替换一条提示，用于把「进行中」收尾成「成功 / 失败」。 */
  updateToast: (id: string, kind: Toast["kind"], message: string) => void;
  setCommandQuery: (query: string) => void;
  setCommandSelection: (index: number) => void;
  resetCommandState: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  activeConnectionId: null,
  toasts: [],
  commandQuery: "",
  commandSelection: 0,
  setActiveConnection: (id) => set({ activeConnectionId: id }),
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
  setCommandQuery: (query) => set({ commandQuery: query }),
  setCommandSelection: (index) => set({ commandSelection: index }),
  resetCommandState: () => set({ commandQuery: "", commandSelection: 0 }),
}));

/** 记住连接成功后最近使用的连接（仅非敏感信息）。 */
export interface RecentConnectionMeta {
  kind: BrokerKind;
  endpoint: string;
}
