//! 集群与运行时的命令。
//!
//! 两个中间件共用「集群页」这个概念，但取数路径完全不同：
//! Kafka 读一次元数据，RabbitMQ 走管理 API 的 `/api/nodes`。
//! 命令层只做分派与降级决策，不写判读逻辑（那在 `domain::cluster_view`）。
//!
//! RabbitMQ 侧的降级规则：节点指标取不到时返回空列表，而不是让整页报错。
//! 「这台集群没开管理插件」和「集群挂了」是两件完全不同的事，
//! 混成一个红色错误页，用户反而看不出该修什么。

use tauri::State;

use crate::broker::Connection;
use crate::domain::{
    BrokerKind, ClusterView, ConnectionDetail, ConnectionId, NodeStat, NodeVerdict, QueuePlacement,
    RuntimeSnapshot, assemble_connections, node_verdicts, place_queues, summarize_cluster,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 集群视图。Kafka 与 RabbitMQ 都支持。
#[tauri::command]
pub async fn load_cluster(state: State<'_, AppState>, id: ConnectionId) -> AppResult<ClusterView> {
    let connection = state.connections.get(&id).await?;
    match connection.as_ref() {
        Connection::Kafka(client) => client.cluster_view().await,
        Connection::RabbitMq(client) => {
            // 管理 API 不可用时 `cluster_nodes` 会返回 `Unsupported`；
            // 这时给一个空集群而不是错误 —— 页面本身还能解释原因。
            let nodes = client.cluster_nodes().await.unwrap_or_default();
            Ok(summarize_cluster(&nodes))
        }
    }
}

/// RabbitMQ 运行时：连接、通道、队列位置。
#[tauri::command]
pub async fn load_runtime(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<RuntimeSnapshot> {
    let connection = state.connections.get(&id).await?;
    if connection.kind() != BrokerKind::RabbitMq {
        return Err(AppError::Unsupported(
            "运行时视图只对 RabbitMQ 可用".to_owned(),
        ));
    }
    let client = connection.as_rabbitmq()?;

    // 三次请求串行：管理插件对并发请求很敏感，交互式面板多花几十毫秒换服务端轻松些。
    let connections = client.connection_rows().await.unwrap_or_default();
    let channels = client.channel_rows().await.unwrap_or_default();
    let queues = client.queue_placements().await.unwrap_or_default();

    let mut snapshot = place_queues(&queues);
    snapshot.connections = assemble_connections(&connections, &channels);
    Ok(snapshot)
}

/// 某个连接下的全部通道（按连接聚合）。
#[tauri::command]
pub async fn load_connection_channels(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<ConnectionDetail>> {
    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;
    let connections = client.connection_rows().await?;
    let channels = client.channel_rows().await.unwrap_or_default();
    Ok(assemble_connections(&connections, &channels))
}

/// 队列位置列表。
#[tauri::command]
pub async fn load_queue_placements(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<QueuePlacement>> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.queue_placements().await
}

/// 节点运行时指标 + 每个节点的一句话结论。
///
/// 只有 RabbitMQ 有这套指标（走管理 API 的 `/api/nodes`）。Kafka 的节点卡
/// 靠元数据就够了，这里返回一份**空的报告**而不是报错：
/// 报错会变成页头一句恒真的「节点指标读取失败」噪音，
/// 而 `verdicts` 一空，「只看需处理」这个筛选对 Kafka 就彻底失效了。
#[tauri::command]
pub async fn load_node_stats(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<NodeReport> {
    let connection = state.connections.get(&id).await?;
    let NodeReportParts { stats, verdicts } = match connection.as_ref() {
        Connection::Kafka(_) => NodeReportParts::default(),
        Connection::RabbitMq(client) => {
            let stats = client.nodes().await?;
            NodeReportParts {
                verdicts: node_verdicts(&stats),
                stats,
            }
        }
    };
    Ok(NodeReport { stats, verdicts })
}

/// 两种中间件共用一份报告形状：没有指标的那一边给空值，而不是造一堆 0。
#[derive(Debug, Default)]
struct NodeReportParts {
    stats: Vec<NodeStat>,
    verdicts: Vec<NodeVerdict>,
}

/// 节点报告：原始指标 + 判读结论。
///
/// 两者一起返回而不是让前端自己判：判读规则（80% 观察线、磁盘下限）
/// 是领域知识，写在两处必然分叉。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeReport {
    pub stats: Vec<NodeStat>,
    pub verdicts: Vec<NodeVerdict>,
}

/// 关闭一条 AMQP 连接。
#[tauri::command]
pub async fn close_amqp_connection(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<()> {
    crate::commands::trace::traced(
        "close_amqp_connection",
        || format!("id={id}, name={name}"),
        async {
            let connection = state.connections.get(&id).await?;
            connection.as_rabbitmq()?.close_connection(&name).await
        },
    )
    .await
}

/// 关闭一个 AMQP 通道。
#[tauri::command]
pub async fn close_amqp_channel(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<()> {
    crate::commands::trace::traced(
        "close_amqp_channel",
        || format!("id={id}, name={name}"),
        async {
            let connection = state.connections.get(&id).await?;
            connection.as_rabbitmq()?.close_channel(&name).await
        },
    )
    .await
}
