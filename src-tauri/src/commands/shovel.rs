//! RabbitMQ 铲子（shovel）运行态命令。
//!
//! 与参数命令的分工：`commands::parameter` 管「打算搬」，这里管「正在搬」。
//! 两者都只在 RabbitMQ 上可用，接线时走 `as_rabbitmq()`。

use tauri::State;

use crate::domain::{ConnectionId, ShovelSnapshot};
use crate::error::AppResult;
use crate::state::AppState;

/// 读铲子快照：配置（参数接口）与运行态（`/api/shovels`）各拉一次再配对。
///
/// 配置拉不到直接报错 —— 那是这条连接 vhost 的权限或管理 API 问题，
/// 页面此时给不出任何可信结论。运行态拉不到则降级：`runtimeError` 非空，
/// 每条配置仍照常显示，只是状态写「无运行态」而不是「已停止」。
#[tauri::command]
pub async fn list_shovels(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<ShovelSnapshot> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.shovel_snapshot().await
}
