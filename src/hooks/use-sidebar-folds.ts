import { useCallback, useState } from "react";

import { connectionFoldKey } from "@/lib/layout";
import { STORAGE_KEYS, readJson, writeJson } from "@/lib/storage";

/**
 * 一条连接自己的「页面菜单摊开 / 收起」。
 *
 * 刻意做成「每个连接行自己持有状态」，而不是「侧栏持有一个折叠集合按 key 查」：
 * 后者看着更函数式，但列表是 react-query 的结果对象，点了箭头只改集合不换
 * 列表引用，行不会重渲染 —— 箭头点了没反应，这正是「无法进行收缩」的来路。
 * 状态放在行里，setState 就直接落在渲染它的那个组件上。
 *
 * 持久化仍然按 `kind@endpoint` 记（重启后运行时 ID 会变，用 ID 当键等于
 * 每次都自己弹开），读写失败静默降级为本次会话记忆。
 */
export function useConnectionFold(connection: { kind: string; endpoint: string }) {
  const key = connectionFoldKey(connection);
  const [expanded, setExpanded] = useState(() => !readCollapsed().includes(key));

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      writeCollapsed(key, !next);
      return next;
    });
  }, [key]);

  return { expanded, toggle };
}

function isKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readCollapsed(): string[] {
  return readJson(STORAGE_KEYS.collapsedConnections, isKeyList) ?? [];
}

function writeCollapsed(key: string, collapsed: boolean): void {
  const rest = readCollapsed().filter((item) => item !== key);
  writeJson(STORAGE_KEYS.collapsedConnections, collapsed ? [...rest, key] : rest);
}
