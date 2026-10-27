/**
 * Tauri IPC 的唯一出口。
 *
 * 上层服务只依赖此模块，便于在浏览器里跑单测时替换实现。
 */

import { invoke } from "@tauri-apps/api/core";

import { toAppError } from "@/lib/errors";

/**
 * 调用后端命令并对错误做统一规整。
 *
 * @param command 命令名，与 Rust 侧 `#[tauri::command]` 的函数名一致
 * @param args 命令参数
 */
export async function call<TResult>(
  command: string,
  args?: Record<string, unknown>,
): Promise<TResult> {
  try {
    return await invoke<TResult>(command, args);
  } catch (error) {
    throw toAppError(error);
  }
}
