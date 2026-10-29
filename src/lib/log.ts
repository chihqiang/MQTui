/**
 * 前端日志出口。
 *
 * 面板里出现「点了没反应」「数据不对」时，最先要看的是「哪个命令、什么参数、多久、
 * 报了什么」。这些信息都在 `services/ipc.ts` 里统一打，页面自己不必重复。
 *
 * 桌面环境（Tauri）下转给插件写进文件，和 Rust 侧日志同一条时间线；
 * 浏览器里跑单测或 Vite 页面时退化为 console。
 */

import { debug as pluginDebug, error as pluginError, info as pluginInfo, warn as pluginWarn } from "@tauri-apps/plugin-log";

/** 是否运行在 Tauri 桌面壳里（浏览器里没有 `__TAURI_INTERNALS__`）。 */
export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function forward(
  toConsole: (message: string) => void,
  toPlugin: (message: string) => Promise<void>,
) {
  return (message: string) => {
    toConsole(message);
    if (!hasTauri()) return;
    // 写日志失败不该反过来影响业务，吞掉即可。
    toPlugin(message).catch(() => undefined);
  };
}

const consoleLine = (level: string) => (message: string) => {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[mqtui] ${message}`,
  );
};

export const log = {
  debug: forward(consoleLine("debug"), pluginDebug),
  info: forward(consoleLine("info"), pluginInfo),
  warn: forward(consoleLine("warn"), pluginWarn),
  error: forward(consoleLine("error"), pluginError),
};

/** 毫秒转成日志里好读的耗时。 */
export function tookText(startedAt: number, now: number = Date.now()): string {
  const millis = Math.max(0, now - startedAt);
  return millis < 1000 ? `${Math.round(millis)}ms` : `${(millis / 1000).toFixed(2)}s`;
}

/**
 * 参数里可能带着用户输入的消息体，整段 JSON 落盘既没用又危险。
 * 这里只留「有几个字段、大小多大」，够判断参数带没带对。
 */
export function argsSummary(args?: Record<string, unknown>): string {
  if (!args) return "无参数";
  const keys = Object.keys(args);
  if (keys.length === 0) return "无参数";
  const parts = keys.map((key) => {
    const value = args[key];
    if (typeof value === "string") return `${key}=${value.length} 字符`;
    if (Array.isArray(value)) return `${key}=${value.length} 项`;
    if (value && typeof value === "object") return `${key}={…}`;
    return `${key}=${String(value)}`;
  });
  return parts.join(", ");
}
