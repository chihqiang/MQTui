/** 连接相关接口，对应 `src-tauri/src/commands/broker.rs`。 */

import { call } from "./ipc";
import type { HealthReport } from "@/types/health";
import type {
  ConnectionConfig,
  ConnectionSummary,
  Overview,
  PluginKind,
} from "@/types/broker";

export const brokerService = {
  /** 支持的中间件及能力清单，用于渲染连接表单与菜单。 */
  listPluginKinds: () => call<PluginKind[]>("list_plugin_kinds"),

  openConnection: (name: string, config: ConnectionConfig) =>
    call<ConnectionSummary>("open_connection", { name, config }),

  listConnections: () => call<ConnectionSummary[]>("list_connections"),

  closeConnection: (id: string) => call<void>("close_connection", { id }),

  loadOverview: (id: string) => call<Overview>("load_overview", { id }),

  /** 连接健康检查：连接状态 / 管理 API / 写权限。 */
  checkHealth: (id: string) => call<HealthReport>("check_health", { id }),
};
