//! 主题 / 队列 / 消息相关命令。

use tauri::State;

use crate::domain::{
    BindingKey, BindingSpec, BrokerKind, ConnectionId, ExchangeSpec, MessageDetail, MessagePage,
    MessageQuery, OrphanScanScope, OrphanTopicPage, QueueDetail, QueueInfo, RabbitMqTopology,
    SendOutcome, SendRequest, TopicInfo,
};
use crate::error::{AppError, AppResult};
use crate::message;
use crate::message::orphans;
use crate::state::AppState;

/// 列出 Kafka 主题。
#[tauri::command]
pub async fn list_topics(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<TopicInfo>> {
    let connection = state.connections.get(&id).await?;
    connection.as_kafka()?.topics().await
}

/// 列出 RabbitMQ 队列。
#[tauri::command]
pub async fn list_queues(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<QueueInfo>> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.queues().await
}

/// 列出 RabbitMQ 交换机与绑定关系（依赖管理 HTTP API）。
#[tauri::command]
pub async fn load_topology(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<RabbitMqTopology> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.topology().await
}

/// 无消费组主题的候选主题列表（只拉元数据，不碰水位）。
#[tauri::command]
pub async fn list_orphan_candidates(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<Vec<String>> {
    let connection = state.connections.get(&id).await?;
    if !orphans::supports(connection.kind()) {
        return Err(orphans::unsupported());
    }
    message::kafka::orphans::candidates(connection.as_kafka()?).await
}

/// 按扫描范围列出没有被任何消费组消费、且仍有堆积的 Kafka 主题。
///
/// `scope` 为空时退化为全量扫描（慢，页面会给出提示）；指定主题或前缀后
/// 只问这些主题的分区水位。
#[tauri::command]
pub async fn list_orphan_topics(
    state: State<'_, AppState>,
    id: ConnectionId,
    scope: Option<OrphanScanScope>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> AppResult<OrphanTopicPage> {
    let connection = state.connections.get(&id).await?;
    if !orphans::supports(connection.kind()) {
        return Err(orphans::unsupported());
    }
    message::kafka::orphans::query(
        connection.as_kafka()?,
        scope.unwrap_or_default(),
        limit,
        offset,
    )
    .await
}

/// 读取 RabbitMQ 队列详情（状态、速率、参数、绑定来源）。
#[tauri::command]
pub async fn get_queue(
    state: State<'_, AppState>,
    id: ConnectionId,
    queue: String,
) -> AppResult<QueueDetail> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.queue_detail(&queue).await
}

/// 清空 RabbitMQ 队列中的消息，保留队列本身。
#[tauri::command]
pub async fn purge_queue(
    state: State<'_, AppState>,
    id: ConnectionId,
    queue: String,
) -> AppResult<()> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.purge_queue(&queue).await
}

/// 删除 RabbitMQ 队列。非空队列会被服务端拒绝，错误信息原样返回。
#[tauri::command]
pub async fn delete_queue(
    state: State<'_, AppState>,
    id: ConnectionId,
    queue: String,
) -> AppResult<()> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.delete_queue(&queue).await
}

/// 新建 RabbitMQ 交换机。
#[tauri::command]
pub async fn create_exchange(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: ExchangeSpec,
) -> AppResult<()> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.create_exchange(&spec).await
}

/// 删除 RabbitMQ 交换机。
///
/// `internal` 由前端从拓扑快照里带过来：管理 API 的交换机删除接口不会替我们判断
/// 「这个交换机是不是内置的」，而界面上需要提前把删除按钮关掉。
#[tauri::command]
pub async fn delete_exchange(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
    internal: Option<bool>,
) -> AppResult<()> {
    let connection = state.connections.get(&id).await?;
    connection
        .as_rabbitmq()?
        .delete_exchange(&name, internal.unwrap_or(false))
        .await
}

/// 新建 RabbitMQ 绑定。
#[tauri::command]
pub async fn create_binding(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: BindingSpec,
) -> AppResult<()> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.create_binding(&spec).await
}

/// 删除 RabbitMQ 绑定。
#[tauri::command]
pub async fn delete_binding(
    state: State<'_, AppState>,
    id: ConnectionId,
    key: BindingKey,
) -> AppResult<()> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.delete_binding(&key).await
}

/// 拉取消息列表。
#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    query: MessageQuery,
) -> AppResult<MessagePage> {
    let id = ConnectionId(query.connection_id.clone());
    let connection = state.connections.get(&id).await?;

    match connection.kind() {
        BrokerKind::Kafka => message::kafka::list(connection.as_kafka()?, query).await,
        BrokerKind::RabbitMq => message::rabbitmq::list(connection.as_rabbitmq()?, query).await,
    }
}

/// 拉取消息详情。
#[tauri::command]
pub async fn get_message(
    state: State<'_, AppState>,
    id: ConnectionId,
    message_id: String,
) -> AppResult<MessageDetail> {
    let connection = state.connections.get(&id).await?;

    match connection.kind() {
        BrokerKind::Kafka => message::kafka::detail(connection.as_kafka()?, &message_id).await,
        BrokerKind::RabbitMq => {
            message::rabbitmq::detail(connection.as_rabbitmq()?, &message_id).await
        }
    }
}

/// 发送消息。
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    request: SendRequest,
) -> AppResult<SendOutcome> {
    ensure_payload(&request)?;

    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;

    let kind = connection.kind();
    let detail = match kind {
        BrokerKind::Kafka => message::kafka::send(connection.as_kafka()?, request).await?,
        BrokerKind::RabbitMq => message::rabbitmq::send(connection.as_rabbitmq()?, request).await?,
    };

    Ok(SendOutcome { kind, detail })
}

/// 当请求体为空时统一给出可读错误，避免向下层传空 payload。
fn ensure_payload(request: &SendRequest) -> AppResult<()> {
    if request.payload.is_empty() {
        return Err(AppError::Invalid("消息内容不能为空".to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_payload_is_rejected() {
        let request = SendRequest {
            connection_id: "id".to_owned(),
            target: "topic".to_owned(),
            key: None,
            payload: String::new(),
            headers: Vec::new(),
            exchange: None,
        };
        assert!(ensure_payload(&request).is_err());
    }
}
