//! 连接相关命令。

use serde::Serialize;
use tauri::State;

use crate::broker;
use crate::domain::{
    BrokerCapability, BrokerKind, ConnectionConfig, ConnectionId, ConnectionSummary, HealthReport,
    Overview,
};
use crate::error::AppResult;
use crate::state::AppState;

/// 支持的中间件及能力声明，前端据此渲染连接表单与菜单。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginKind {
    pub kind: BrokerKind,
    pub display_name: &'static str,
    pub capabilities: &'static [BrokerCapability],
}

#[tauri::command]
pub fn list_plugin_kinds() -> Vec<PluginKind> {
    [BrokerKind::Kafka, BrokerKind::RabbitMq]
        .into_iter()
        .map(|kind| PluginKind {
            kind,
            display_name: kind.display_name(),
            capabilities: kind.capabilities(),
        })
        .collect()
}

/// 建立连接。
#[tauri::command]
pub async fn open_connection(
    state: State<'_, AppState>,
    name: String,
    config: ConnectionConfig,
) -> AppResult<ConnectionSummary> {
    state.connections.open(name, config).await
}

/// 列出已建立的连接。
#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionSummary>> {
    Ok(state.connections.list().await)
}

/// 关闭连接。
#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, id: ConnectionId) -> AppResult<()> {
    state.connections.close(&id).await
}

/// 读取连接概览。
#[tauri::command]
pub async fn load_overview(state: State<'_, AppState>, id: ConnectionId) -> AppResult<Overview> {
    let connection = state.connections.get(&id).await?;
    broker::overview(&connection).await
}

/// 连接健康检查：一次探测连接状态、管理 API 可达性、写权限。
///
/// 探测失败不返回错误而是体现在报告项里——「管理 API 不可用」是本页要展示的信息，
/// 而不是让整页变成错误态。
#[tauri::command]
pub async fn check_health(state: State<'_, AppState>, id: ConnectionId) -> AppResult<HealthReport> {
    let connection = state.connections.get(&id).await?;
    match connection.kind() {
        BrokerKind::Kafka => connection.as_kafka()?.health().await,
        BrokerKind::RabbitMq => connection.as_rabbitmq()?.health().await,
    }
}
