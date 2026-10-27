/** 新建 / 编辑连接流程里共用的类型与常量。 */

import type { BrokerKind, ConnectionConfig } from "./broker.ts";

/**
 * 保存过的连接。存储实现在 `lib/session-storage.ts`，形状放这里 ——
 * 「什么算一条连接」是数据，不是方法。
 */
export interface SavedConnection {
  /** 稳定标识，由 kind + name 派生，同名同类型视为同一条。 */
  id: string;
  name: string;
  config: ConnectionConfig;
  /** 保存时间（毫秒）。 */
  savedAt: number;
}

/** 弹窗里那个表单的 id：页脚的提交按钮在 form 之外，用 `form` 属性指过来。 */
export const UNSAVED_FORM_ID = "unsaved-connection-form";

/** 向导里那份表单的 id（没有历史记录时走的那条路径）。 */
export const CONNECT_FORM_ID = "connect-form";

/**
 * 向导当前要连的目标。
 *
 * `kind` 非空 = 用户已经点过某一种中间件（首页卡片、新建行的按钮、记录行的编辑），
 * 弹窗直接进表单；为空只有一种情况 —— 顶栏「＋」，那里没有任何前置选择。
 */
export interface ConnectTarget {
  kind: BrokerKind | null;
  /** 从「已保存」的历史进来时带上整条记录。 */
  saved?: SavedConnection;
  /** 从「连过 · 未保存」的历史进来时带上地址：参数不在本机，能填的先填上。 */
  endpoint?: string;
}

/** 向导里的表单草稿：编辑记录时带原配置，只记得地址时只带地址。 */
export interface ConnectBuilder {
  kind: BrokerKind | null;
  /** 非空表示从连接记录里「编辑」，此时带原名、原配置。 */
  saved?: SavedConnection;
  name: string;
  /**
   * 只有地址的历史（`recent-connections` 存不下口令）预填用。
   *
   * 它不是「配置」—— 配置缺失的字段仍走表单默认值与草稿，这里只覆盖地址那一格。
   */
  endpoint?: string | null;
}
