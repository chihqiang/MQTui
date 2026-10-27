/**
 * 与 `src-tauri/src/domain/shovel.rs` 一一对应的领域类型。
 * 修改 Rust 侧结构时请同步更新此文件。
 */

import type { ParameterInfo } from "./parameter.ts";

/** 铲子状态。取值就是管理 API `state` 字段归一后的三态。 */
export type ShovelState = "running" | "starting" | "terminated";

/** 运行态里的一行。 */
export interface ShovelRuntime {
  name: string;
  vhost: string;
  state: ShovelState;
  /** `static`（配置里声明的）或 `dynamic`（运行中通过 API 起的）。 */
  kind: string;
  /** 失败 / 停止原因。空串表示没给。 */
  reason: string;
  /** 源 / 目标地址，后端已打码。 */
  srcUri: string;
  destUri: string;
  /** 累计搬运条数 —— 「真的搬过东西」的唯一证据。 */
  messagesTransferred: number;
}

/** 配置与运行态合并后的一行。 */
export interface ShovelRow {
  name: string;
  vhost: string;
  /** 配置存在的话，那一行参数。 */
  config: ParameterInfo | null;
  /** 运行态存在的话，那一行状态。 */
  runtime: ShovelRuntime | null;
  /** 为什么「看着正常但不动」。空串表示没发现问题。 */
  problem: string;
  /** 配置不在当前连接的 vhost 里。 */
  foreign: boolean;
}

export interface ShovelSnapshot {
  rows: ShovelRow[];
  /** 读运行态失败的原因（插件未启用 / 权限不足）。空表示读到了。 */
  runtimeError: string | null;
}
