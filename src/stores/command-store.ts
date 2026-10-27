/**
 * 命令面板的可见性。
 *
 * 面板挂在应用外壳上，而触发按钮在侧边栏顶栏 —— 两者不是父子关系，
 * 所以用一个极小的 store 传递「打开」这个意图，比逐层传 props 干净。
 */

import { create } from "zustand";

interface CommandState {
  visible: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useCommandStore = create<CommandState>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
  toggle: () => set((state) => ({ visible: !state.visible })),
}));
