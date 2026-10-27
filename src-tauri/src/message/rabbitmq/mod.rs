//! RabbitMQ 消息实现：按 queue 拉取，消息 ID 使用 `queue:deliveryTag`。

pub mod dto;
pub mod redeliver;

use lapin::BasicProperties;

use crate::broker::rabbitmq::RabbitMqClient;
use crate::broker::rabbitmq::dto::field_table_from_headers;
use crate::domain::{MessageDetail, MessageHeader, MessagePage, MessageQuery};
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
///
/// AMQP 侧的参数比 Kafka 多：exchange + routing key 决定路由，headers 是业务链路信息，
/// 投递模式决定消息能不能活过 broker 重启。上一版走 `publish`，属性里硬编码了
/// `text/plain` 与非持久化 —— 于是「发一条持久化消息看看」这种最常见的验证根本做不了。
///
/// `content_type` / `content_encoding` 现在是参数而不是常量：发一条 JSON 却不是
/// `application/json`，按类型分派的消费者会走错分支，而且**不报错** —— 收下了，
/// 只是当成另一类东西处理。这比直接失败更难查。
///
/// 属性收成 `MessageProperties` 而不是继续摊平成一个参数列表：投递模式、内容类型、
/// 编码、headers 说的本来就是同一件事 ——「这条消息长什么样」。
/// 摊成四个并列参数，调用处一眼看不出它们是一组，多来一个就得再加一个。
pub async fn send(
    client: &RabbitMqClient,
    exchange: &str,
    routing_key: &str,
    payload: &[u8],
    properties: MessageProperties<'_>,
) -> AppResult<String> {
    client
        .publish_with(exchange, routing_key, payload, properties.to_basic())
        .await
}

/// 一条待投递消息的 AMQP 属性。
pub struct MessageProperties<'a> {
    /// `1` 非持久化、`2` 持久化。取值合法性由命令层先拦过。
    pub delivery_mode: u8,
    /// 内容类型；`None` 用 `DEFAULT_CONTENT_TYPE`。
    pub content_type: Option<&'a str>,
    /// 内容编码；`None` 表示不带这个属性（不是「空编码」）。
    pub content_encoding: Option<&'a str>,
    pub headers: &'a [MessageHeader],
}

impl MessageProperties<'_> {
    fn to_basic(&self) -> BasicProperties {
        let mut properties = BasicProperties::default()
            .with_content_type(
                self.content_type
                    .unwrap_or(crate::domain::message::DEFAULT_CONTENT_TYPE)
                    .to_owned()
                    .into(),
            )
            .with_delivery_mode(self.delivery_mode)
            .with_headers(field_table_from_headers(
                &self
                    .headers
                    .iter()
                    .map(|header| (header.key.clone(), header.value.clone()))
                    .collect::<Vec<_>>(),
            ));
        // `None` 与 `Some("")` 在 AMQP 里是两种状态，这里只负责「带不带」，
        // 至于空串要不要变成不带，是命令层判断过的。
        if let Some(encoding) = self.content_encoding {
            properties = properties.with_content_encoding(encoding.to_owned().into());
        }
        properties
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::message::DEFAULT_CONTENT_TYPE;

    /// 没填内容类型时保持旧行为：换默认值等于让所有没填这一格的消息在下游换条路走。
    #[test]
    fn missing_content_type_falls_back_to_plain_text() {
        let properties = MessageProperties {
            delivery_mode: 1,
            content_type: None,
            content_encoding: None,
            headers: &[],
        }
        .to_basic();

        assert_eq!(
            properties
                .content_type()
                .as_ref()
                .map(|value| value.as_str()),
            Some(DEFAULT_CONTENT_TYPE)
        );
    }

    #[test]
    fn content_type_is_carried_through() {
        let properties = MessageProperties {
            delivery_mode: 2,
            content_type: Some("application/json"),
            content_encoding: Some("gzip"),
            headers: &[],
        }
        .to_basic();

        assert_eq!(
            properties
                .content_type()
                .as_ref()
                .map(|value| value.as_str()),
            Some("application/json")
        );
        assert_eq!(
            properties
                .content_encoding()
                .as_ref()
                .map(|value| value.as_str()),
            Some("gzip")
        );
        assert_eq!(properties.delivery_mode(), &Some(2));
    }

    /// `content_encoding` 不填就不带这个属性 —— AMQP 里「没有」和「有且为空」是两回事。
    #[test]
    fn empty_content_encoding_is_omitted() {
        let properties = MessageProperties {
            delivery_mode: 1,
            content_type: None,
            content_encoding: None,
            headers: &[],
        }
        .to_basic();

        assert_eq!(properties.content_encoding().as_ref(), None);
    }
}
