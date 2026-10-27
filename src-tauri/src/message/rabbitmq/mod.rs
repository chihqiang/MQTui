//! RabbitMQ 消息实现：按 queue 拉取，消息 ID 使用 `queue:deliveryTag`。

pub mod dto;
pub mod redeliver;

use crate::broker::rabbitmq::RabbitMqClient;
use crate::domain::{MessageDetail, MessagePage, MessageQuery, SendRequest};
use crate::error::{AppError, AppResult};

/// 拉取队列消息。
///
/// AMQP 只能顺次取消息，没有跨页的稳定位点，因此这里不支持游标续读：
/// 每一页都是「当下队列里的前 limit 条」，由前端负责去重。
pub async fn list(client: &RabbitMqClient, query: MessageQuery) -> AppResult<MessagePage> {
    // 只有「加载更多」会被拒绝：「加载最新」不带游标，重读一次没有副作用。
    if query
        .cursor
        .as_deref()
        .is_some_and(|cursor| !cursor.is_empty())
    {
        return Err(AppError::Unsupported(
            "RabbitMQ 不支持按游标翻页，请重新拉取".to_owned(),
        ));
    }

    // 分区是 Kafka 的概念。这里不静默忽略：悄悄返回全部消息，
    // 前端会以为过滤生效了。
    if query.partition.is_some() {
        return Err(AppError::Unsupported(
            "RabbitMQ 的队列没有分区，不能按分区筛选".to_owned(),
        ));
    }

    let limit = super::clamp_limit(query.limit);
    let queue = query.target;

    let deliveries = client.get_messages(&queue, limit).await?;
    let items = deliveries
        .iter()
        .map(dto::summary_from_delivery)
        .collect::<Vec<_>>();

    Ok(MessagePage {
        // 没有游标就翻不动，别给出「还有更多」的假希望。
        has_more: false,
        cursor: None,
        source: queue,
        items,
    })
}

/// 读取队列中的单条消息。
///
/// AMQP 没有「按 deliveryTag 随机读」的能力。列表阶段为了不破坏队列已经放回消息
/// （`basic.reject(requeue = true)`），放回后 deliveryTag 会被重新分配，
/// 用列表里的旧 tag 回源基本查不到——所以前端应优先使用列表带回的 payload。
///
/// 这里仍保留一次尽力而为的查找：查得到就返回真实内容，查不到返回占位详情，
/// 而不是抛 404。语义上「消息存在过、只是现在读不到内容」，比「消息不存在」更贴近事实。
pub async fn detail(client: &RabbitMqClient, id: &str) -> AppResult<MessageDetail> {
    let (queue, tag) = dto::parse_id(id)?;

    let found = match client.get_messages(&queue, super::MAX_MESSAGE_LIMIT).await {
        Ok(deliveries) => deliveries
            .iter()
            .find(|delivery| delivery.delivery_tag == tag)
            .map(dto::detail_from_delivery),
        // 队列可能已被删除：读取失败不阻断详情接口，交给占位内容兜底。
        Err(_) => None,
    };

    match found {
        Some(detail) => Ok(detail),
        None => dto::placeholder_from_id(id),
    }
}

/// 发送消息。
pub async fn send(client: &RabbitMqClient, request: SendRequest) -> AppResult<String> {
    let exchange = request.exchange.as_deref().unwrap_or("");
    let headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|header| (header.key.clone(), header.value.clone()))
        .collect();

    client
        .publish(
            exchange,
            &request.target,
            request.payload.as_bytes(),
            &headers,
        )
        .await
}
