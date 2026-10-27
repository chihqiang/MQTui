//! 消费组相关命令。
//!
//! 与消息命令同构：解析参数 → 取连接 → 交给 `message` 层 → 转换错误。

use tauri::State;

use crate::domain::lag_trend::LagTrend;
use crate::domain::{BrokerKind, ConnectionId, ConsumerGroupDetail};
use crate::error::AppResult;
use crate::message::consumer::{self as groups, ConsumerGroupPage};
use crate::state::AppState;

/// 列出消费组，支持关键字过滤与游标翻页。
#[tauri::command]
pub async fn list_consumer_groups(
    state: State<'_, AppState>,
    id: ConnectionId,
    keyword: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
) -> AppResult<ConsumerGroupPage> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::Kafka {
        return Err(groups::unsupported());
    }

    let page = crate::message::kafka::consumer_groups::list(
        connection.as_kafka()?,
        groups::query(keyword),
        limit,
        cursor,
    )
    .await?;

    Ok(page.into())
}

/// 读取单个消费组的成员与分区滞后。
#[tauri::command]
pub async fn get_consumer_group(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
) -> AppResult<ConsumerGroupDetail> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::Kafka {
        return Err(groups::unsupported());
    }

    crate::message::kafka::consumer_groups::detail(connection.as_kafka()?, &group).await
}

/// 采样一个消费组的滞后趋势：读两次进度，算「在追还是在欠」。
///
/// 与 `get_consumer_group` 分开成一个命令，而不是加个 `sample: bool` 参数：
/// 详情是瞬时读取、随时可点；趋势要等一个窗口（默认 5 秒），代价完全不同。
/// 混在一个命令里，弹窗打开时就会被拖住五秒。
#[tauri::command]
pub async fn sample_consumer_lag_trend(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
    window_ms: Option<u64>,
) -> AppResult<LagTrend> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::Kafka {
        return Err(groups::unsupported());
    }

    crate::message::kafka::lag_trend::sample(connection.as_kafka()?, &group, window_ms).await
}
