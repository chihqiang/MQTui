//! Kafka 准入类命令：客户端配额与 SASL/SCRAM 凭据。
//!
//! 两个命令分开注册，是因为它们的失败面不同：配额读不到是常态
//! （librdkafka 未导出 `DescribeClientQuotas`），SCRAM 读不到要么是权限、
//! 要么是 broker 版本 —— 合在一个命令里，一个失败会把另一个也拖成错误页。
//!
//! 两者都是只读。改配额、改凭据需要 librdkafka 没有导出的写 API，
//! 硬凑出来的按钮只会给人一种「已经改好了」的错觉。

use tauri::State;

use crate::domain::{ConnectionId, QuotaSnapshot, ScramSnapshot};
use crate::error::AppResult;
use crate::message::kafka::quota;
use crate::state::AppState;

/// 读取客户端配额，附带 broker 级默认值。
#[tauri::command]
pub async fn describe_client_quotas(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<QuotaSnapshot> {
    let connection = state.connections.get(&id).await?;
    quota::quota(connection.as_kafka()?).await
}

/// 读取全部用户的 SASL/SCRAM 凭据。
///
/// broker 低于 2.7.0 时返回一份带 `unsupported` 的快照，而不是错误：
/// 「这台 broker 问不了」是这一屏的正常状态，不该把整页做成错误页。
#[tauri::command]
pub async fn describe_user_scram_credentials(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<ScramSnapshot> {
    let connection = state.connections.get(&id).await?;
    quota::scram(connection.as_kafka()?).await
}
