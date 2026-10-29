/**
 * Tauri IPC 的唯一出口。
 *
 * 上层服务只依赖此模块，便于在浏览器里跑单测时替换实现。
 *
 * 每条命令的进出都在这里记一笔：成功记 debug（附耗时），失败记 error（附耗时、参数摘要
 * 与错误种类）。排查「点了没反应」时先看这一段，不必再去每个页面加 console。
 */

import { invoke } from "@tauri-apps/api/core";

import { toAppError } from "@/lib/errors";
import { argsSummary, log, tookText } from "@/lib/log";

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
  const startedAt = Date.now();
  try {
    const result = await invoke<TResult>(command, args);
    log.debug(`${command} 完成，耗时 ${tookText(startedAt)}，参数：${argsSummary(args)}`);
    return result;
  } catch (error) {
    const payload = toAppError(error);
    // 失败一定带上参数摘要：区分「后端不认这个 id」和「前端根本没传」全靠它。
    log.error(
      `${command} 失败 [${payload.kind}]，耗时 ${tookText(startedAt)}，参数：${argsSummary(args)}，错误：${payload.message}`,
    );
    throw payload;
  }
}
