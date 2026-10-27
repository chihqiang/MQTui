//! 消费组相关命令。
//!
//! 与消息命令同构：解析参数 → 取连接 → 交给 `message` 层 → 转换错误。

use tauri::State;

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
