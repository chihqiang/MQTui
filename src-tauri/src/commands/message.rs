//! 主题 / 队列 / 消息相关命令。

use tauri::State;

use crate::domain::consumer_disconnect as disconnect;
use crate::domain::{
    BatchDisposalOutcome, BatchDisposalRequest, BindingKey, BindingSpec, BrokerKind, ConnectionId,
    ConsumerGraph, ConsumerLinks, DeadLetterRequest, DisconnectRequest, DisposalCapabilities,
    DisposalOutcome, ExchangeSpec, MessageDetail, MessageLocate, MessagePage, MessageQuery,
    MessageSearch, OrphanScanScope, OrphanTopicPage, QueueDetail, QueueInfo, RabbitMqTopology,
    RedeliverRequest, ResendOutcome, ResendRequest, SendOutcome, SendRequest, TopicInfo,
    TopologyGraph, TopologyInsight,
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

/// 交换机到队列的路由估算：哪些队列收得到、哪些交换机是死路。
#[tauri::command]
pub async fn load_topology_insight(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<TopologyInsight> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.topology_insight().await
}

/// RabbitMQ 拓扑图：交换机与队列的分层布局 + 连线。
///
/// 布局在后端算完，前端只负责按坐标画。环、同名节点这类规则不写在渲染层里。
#[tauri::command]
pub async fn load_topology_graph(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<TopologyGraph> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.topology_graph().await
}

/// 消费者连线图：交换机 → 队列 → 消费者连接。
#[tauri::command]
pub async fn load_consumer_graph(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<ConsumerGraph> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.consumer_graph().await
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

/// 队列到消费者的连线：每个队列上的消费者、预取与未确认情况。
///
/// 走管理 API：AMQP 协议没有「查看别人 channel 的消费状态」这回事。
#[tauri::command]
pub async fn list_queue_consumers(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<ConsumerLinks> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.consumer_links().await
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

/// 断开一个 RabbitMQ 消费者。
///
/// 三步顺序不能换：
/// 1. 校验用户输入的确认串（与队列名一致）；
/// 2. 从当前消费者快照里找到这个 tag，并复核它是否可断（在途消息 / 面板自己的消费者都拦下）；
/// 3. 真正发起 `DELETE /api/consumers/...`。
///
/// 第 2 步是刻意多花一次请求的：界面上那颗按钮的可用状态来自几秒前的快照，
/// 期间消费者可能刚好领了一批消息开始干活。断一个正在处理消息的消费者，
/// 代价是那批消息回队并被重复投递——这比多一次请求贵得多。
#[tauri::command]
pub async fn disconnect_consumer(
    state: State<'_, AppState>,
    request: DisconnectRequest,
) -> AppResult<()> {
    request.validate().map_err(AppError::Invalid)?;

    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;

    let consumers = client.consumer_links().await?.queues;
    let founded = consumers
        .iter()
        .flat_map(|item| item.consumers.iter())
        .find(|consumer| {
            consumer.consumer_tag == request.consumer_tag.trim() && consumer.queue == request.queue
        });

    let Some(consumer) = founded else {
        return Err(AppError::NotFound(format!(
            "消费者 {}（队列 {}）",
            request.consumer_tag, request.queue
        )));
    };

    let verdict = disconnect::evaluate(consumer);
    if !verdict.is_allowed() {
        return Err(AppError::Invalid(verdict.note().to_owned()));
    }

    client.disconnect_consumer(&request.consumer_tag).await
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

/// 按 key / 时间区间在 Kafka 日志里定位消息。
///
/// 这是顺序扫描，不是索引查询：扫描条数有上限，结果里会明确回报
/// 扫了多少条、是否被截断。RabbitMQ 没有对应的定位能力。
#[tauri::command]
pub async fn locate_messages(
    state: State<'_, AppState>,
    request: MessageLocate,
) -> AppResult<MessageSearch> {
    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    message::kafka::locate::locate(connection.as_kafka()?, request).await
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
///
/// 参数按中间件分成两个入口：Kafka 只认 topic / key / payload，RabbitMQ 认
/// exchange / routing key / delivery mode / headers。合成一条路径的代价是
/// 「填了但没生效」——那是最难自查的一类问题，所以这里宁可多一个 match 分支。
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    request: SendRequest,
) -> AppResult<SendOutcome> {
    match &request {
        SendRequest::Kafka {
            connection_id,
            topic,
            key,
            payload,
        } => {
            ensure_payload(payload)?;
            let connection = state
                .connections
                .get(&ConnectionId(connection_id.clone()))
                .await?;
            let detail = message::kafka::send(
                connection.as_kafka()?,
                topic,
                key.as_deref(),
                payload.as_bytes(),
            )
            .await?;
            Ok(SendOutcome {
                kind: BrokerKind::Kafka,
                detail,
            })
        }
        SendRequest::RabbitMq {
            connection_id,
            exchange,
            routing_key,
            payload,
            delivery_mode,
            content_type,
            content_encoding,
            headers,
        } => {
            ensure_payload(payload)?;
            ensure_delivery_mode(*delivery_mode)?;
            let content_type = normalize_content_type(content_type.as_deref())?;
            let content_encoding = normalize_content_encoding(content_encoding.as_deref())?;
            let connection = state
                .connections
                .get(&ConnectionId(connection_id.clone()))
                .await?;
            let detail = message::rabbitmq::send(
                connection.as_rabbitmq()?,
                exchange,
                routing_key,
                payload.as_bytes(),
                message::rabbitmq::MessageProperties {
                    delivery_mode: *delivery_mode,
                    content_type: content_type.as_deref(),
                    content_encoding: content_encoding.as_deref(),
                    headers,
                },
            )
            .await?;
            Ok(SendOutcome {
                kind: BrokerKind::RabbitMq,
                detail,
            })
        }
    }
}

/// 单条消息的处置能力：能不能重投、能不能进死信，以及不能的原因。
///
/// 单独成命令的意义与主题能力一致：按钮能不能点是渲染阶段的事，
/// 不该等用户点了再吃一个服务端错误。
#[tauri::command]
pub async fn get_disposal_capabilities(
    state: State<'_, AppState>,
    id: ConnectionId,
    message_id: String,
) -> AppResult<DisposalCapabilities> {
    let connection = state.connections.get(&id).await?;
    message::rabbitmq::redeliver::capabilities(connection.as_rabbitmq()?, &message_id).await
}

/// 重新投递一条 RabbitMQ 消息到指定交换机。
///
/// 只有 RabbitMQ 有这个概念：Kafka 的消息按 offset 存储在日志里，
/// 「重发」就是再 produce 一条新消息，语义完全不同，不在这条路径上。
#[tauri::command]
pub async fn redeliver_message(
    state: State<'_, AppState>,
    request: RedeliverRequest,
) -> AppResult<DisposalOutcome> {
    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    message::rabbitmq::redeliver::redeliver(connection.as_rabbitmq()?, &request).await
}

/// 把一条 RabbitMQ 消息移入队列声明的死信交换机。
#[tauri::command]
pub async fn dead_letter_message(
    state: State<'_, AppState>,
    request: DeadLetterRequest,
) -> AppResult<DisposalOutcome> {
    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    message::rabbitmq::redeliver::dead_letter(connection.as_rabbitmq()?, &request).await
}

/// 批量处置：对同一个队列里的多条消息执行同一个动作。
///
/// 返回**逐条结果**而不是成败二选一：批量操作不可回滚，
/// 只报「失败」会让用户完全不知道哪几条已经离开了队列。
#[tauri::command]
pub async fn batch_dispose_messages(
    state: State<'_, AppState>,
    request: BatchDisposalRequest,
) -> AppResult<BatchDisposalOutcome> {
    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    message::rabbitmq::redeliver::batch(connection.as_rabbitmq()?, &request)
        .await
        .map_err(AppError::Invalid)
}

/// 重试「没放回队列」的那批消息。
///
/// 与批量处置分开成一个命令，是因为它做的事完全不同：**只放回、不处置**。
/// 输入就是上一轮结果里的 `stranded`（用户当时没选中的那些消息），
/// 队列名由调用方带上 —— 那批消息的队列不一定是「选中的那几条」所在的队列。
///
/// 合成一个命令会让「重试」不得不带一个假的 action，而这恰恰是最容易
/// 出事故的地方：真有人把它当成「再处置一次」，就会把用户没选中的消息投出去。
#[tauri::command]
pub async fn retry_stranded_messages(
    state: State<'_, AppState>,
    request: BatchDisposalRequest,
) -> AppResult<BatchDisposalOutcome> {
    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    message::rabbitmq::redeliver::retry_stranded(connection.as_rabbitmq()?, &request)
        .await
        .map_err(AppError::Invalid)
}

/// 重发一条 Kafka 消息：用同样的 key / 内容再写一条新消息。
///
/// 注意这不是「移动」，原消息仍原样留在日志里。返回新消息的落点分区，
/// 同一条 key 换了分区时会在 note 里说明。
#[tauri::command]
pub async fn resend_message(
    state: State<'_, AppState>,
    request: ResendRequest,
) -> AppResult<ResendOutcome> {
    let id = ConnectionId(request.connection_id.clone());
    let connection = state.connections.get(&id).await?;
    message::kafka::resend::resend(connection.as_kafka()?, &request).await
}

/// 当请求体为空时统一给出可读错误，避免向下层传空 payload。
fn ensure_payload(payload: &str) -> AppResult<()> {
    if payload.is_empty() {
        return Err(AppError::Invalid("消息内容不能为空".to_owned()));
    }
    Ok(())
}

/// 投递模式只接受 1 / 2。
///
/// lapin 的 `with_delivery_mode` 收到别的数字不会报错，只是当没设过 ——
/// 于是「我勾了持久化」和「我以为自己勾了持久化」在界面上长得一模一样。
fn ensure_delivery_mode(mode: u8) -> AppResult<()> {
    if crate::domain::delivery_mode::is_valid(mode) {
        return Ok(());
    }
    Err(AppError::Invalid(format!(
        "投递模式只能是 1（非持久化）或 2（持久化），收到 {mode}"
    )))
}

/// 内容类型：去空白、空串视为「没填」、长度与空白在这里挡住。
///
/// 空串当没填而不是报错：表单清空的格子传上来就是空串，那不是用户的错误。
/// 但真填了东西就得合法 —— `application/json` 少个斜杠在 AMQP 里不会被拒，
/// 只是下游认不出来。
fn normalize_content_type(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if let Some(problem) = crate::domain::content_type_problem(trimmed) {
        return Err(AppError::Invalid(format!("内容类型不合法：{problem}")));
    }
    Ok(Some(trimmed.to_owned()))
}

/// 内容编码同上，只是不限定形状（`gzip` / `utf-8` / `br` 都合法）。
fn normalize_content_encoding(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if let Some(problem) = crate::domain::content_type_problem(trimmed) {
        return Err(AppError::Invalid(format!("内容编码不合法：{problem}")));
    }
    Ok(Some(trimmed.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_blank_counts_as_unset() {
        assert_eq!(normalize_content_type(None).unwrap(), None);
        assert_eq!(normalize_content_type(Some("")).unwrap(), None);
        assert_eq!(normalize_content_type(Some("   ")).unwrap(), None);
        assert_eq!(
            normalize_content_type(Some(" application/json ")).unwrap(),
            Some("application/json".to_owned())
        );
    }

    #[test]
    fn content_type_with_space_or_overlong_is_rejected() {
        // 有空格：AMQP 会原样收下，下游按类型分派时才认不出来。
        assert!(normalize_content_type(Some("application / json")).is_err());
        let long = "a".repeat(256);
        assert!(normalize_content_type(Some(&long)).is_err());
        // 255 字节是 AMQP shortstr 的上限，不是「差不多就行」。
        assert!(normalize_content_type(Some(&"a".repeat(255))).is_ok());
    }

    #[test]
    fn content_encoding_blank_counts_as_unset() {
        assert_eq!(normalize_content_encoding(Some(" ")).unwrap(), None);
        assert_eq!(
            normalize_content_encoding(Some("gzip")).unwrap(),
            Some("gzip".to_owned())
        );
    }

    #[test]
    fn empty_payload_is_rejected() {
        assert!(ensure_payload("").is_err());
        assert!(ensure_payload(" ").is_ok());
    }

    #[test]
    fn delivery_mode_only_accepts_broker_values() {
        assert!(ensure_delivery_mode(1).is_ok());
        assert!(ensure_delivery_mode(2).is_ok());
        // 0 是「没设过」，3 是别处的枚举值，两者都不该被悄悄忽略。
        assert!(ensure_delivery_mode(0).is_err());
        assert!(ensure_delivery_mode(3).is_err());
    }
}
