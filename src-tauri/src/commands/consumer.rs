//! 消费组相关命令。
//!
//! 与消息命令同构：解析参数 → 取连接 → 交给 `message` 层 → 转换错误。

use tauri::State;

use crate::domain::lag_trend::LagTrend;
use crate::domain::{
    BlockReport, BrokerKind, ConnectionId, ConsumerGroupDetail, GroupAssignment,
    GroupRemovalPreflight,
};
use crate::error::AppResult;
use crate::message::consumer::{self as groups, ConsumerGroupPage};
use crate::message::kafka::topics::GroupRemovalOutcome;
use crate::state::AppState;

use super::trace;

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

/// 读取消费组的成员分区归属：每个成员负责哪些分区。
///
/// 与 `get_consumer_group` 分开：详情一打开就要看，归属只在想追问
/// 「这个分区压在谁身上」时才需要。合成一个命令等于让每次打开弹窗
/// 都多等一次组成员往返。
#[tauri::command]
pub async fn get_consumer_group_assignment(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
) -> AppResult<GroupAssignment> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::Kafka {
        return Err(groups::unsupported());
    }

    crate::message::kafka::consumer_groups::assignment(connection.as_kafka()?, &group).await
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

/// 采样队头阻塞：读两次组内进度，找「有滞后但一动不动」的分区。
///
/// 与滞后趋势是两个问题，所以是两个命令：趋势是「积压的方向」，
/// 阻塞是「谁卡住了」。混在一起会让结论含糊成「有点问题」。
#[tauri::command]
pub async fn sample_consumer_block(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
    window_ms: Option<u64>,
) -> AppResult<BlockReport> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::Kafka {
        return Err(groups::unsupported());
    }

    crate::message::kafka::group_block::sample(connection.as_kafka()?, &group, window_ms).await
}

/// 删除前的预检：哪些组会被服务端拒绝（还有在线成员）、删掉会丢多少位点。
///
/// 放在删除**之前**单独一个命令，而不是让 `delete_consumer_groups` 自己先探一遍：
/// 预检是给确认框看的，用户点开弹窗时才需要；真删的时候再探一次只是多等一轮。
///
/// 读不到成员时不报错、也不拦人 —— 预检是辅助信息，让它挡住一次正常的删除，
/// 比不预检更糟。
#[tauri::command]
pub async fn preflight_group_removal(
    state: State<'_, AppState>,
    id: ConnectionId,
    groups_to_delete: Vec<String>,
) -> AppResult<GroupRemovalPreflight> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::Kafka {
        return Err(groups::unsupported());
    }

    crate::message::kafka::group_removal::preflight(connection.as_kafka()?, groups_to_delete).await
}

/// 删除消费组。
///
/// 返回「删掉了谁 / 谁没删掉、为什么」，不是一个整体错误：
/// 一批里删掉一部分是常态（活跃组会被服务端拒绝），
/// 合并成一个失败会让人以为一个都没删。
#[tauri::command]
pub async fn delete_consumer_groups(
    state: State<'_, AppState>,
    id: ConnectionId,
    groups_to_delete: Vec<String>,
) -> AppResult<GroupRemovalOutcome> {
    let groups_desc = trace::brief(&groups_to_delete);
    crate::commands::trace::traced(
        "delete_consumer_groups",
        || format!("id={id}, groups={groups_desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            if connection.kind() != BrokerKind::Kafka {
                return Err(groups::unsupported());
            }

            crate::message::kafka::topics::delete_consumer_groups(
                connection.as_kafka()?,
                groups_to_delete,
            )
            .await
        },
    )
    .await
}
