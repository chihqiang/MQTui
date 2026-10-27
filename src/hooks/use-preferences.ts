import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_PREFERENCES,
  readPreferences,
  savePreferences,
  type Preferences,
} from "@/lib/workspace-storage";

/**
 * 用户偏好（侧边栏折叠等）。
 *
 * localStorage 本身不是响应式的，这里用 `useSyncExternalStore` 给它加一层订阅：
 * 侧边栏和内容区都要读同一份偏好，各自 `useState` 就会出现「一边收起、一边还占位」，
 * 而后者的额外状态同步比转发一次广播更啰嗦。
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let cache: Preferences = readPreferences();

function emit(next: Preferences): void {
  cache = next;
  savePreferences(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Preferences {
  return cache;
}

/** 读取偏好并暴露一个不可变的更新方法。 */
export function usePreferences(): [Preferences, (patch: Partial<Preferences>) => void] {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_PREFERENCES);

  const update = useCallback((patch: Partial<Preferences>) => {
    emit({ ...cache, ...patch });
  }, []);

  return [preferences, update];
}
