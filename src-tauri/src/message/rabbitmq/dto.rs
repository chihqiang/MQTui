//! RabbitMQ 消息与领域模型转换。

use crate::broker::rabbitmq::client::RawDelivery;
use crate::domain::{MessageDetail, MessageHeader, MessageSummary};
use crate::error::{AppError, AppResult};

/// 解析 `queue:deliveryTag` 形式的消息 ID。
pub fn parse_id(id: &str) -> AppResult<(String, u64)> {
    let Some((queue, tag)) = id.rsplit_once(':') else {
        return Err(AppError::Invalid(format!("非法的消息 ID: {id}")));
    };
    let tag = tag
        .parse::<u64>()
        .map_err(|_| AppError::Invalid(format!("非法的消息 ID: {id}")))?;
    Ok((queue.to_owned(), tag))
}

pub fn message_id(delivery: &RawDelivery) -> String {
    format!("{}:{}", delivery.queue, delivery.delivery_tag)
}

/// 由原始投递生成摘要。
pub fn summary_from_delivery(delivery: &RawDelivery) -> MessageSummary {
    MessageSummary {
        id: message_id(delivery),
        key: delivery
            .properties
            .message_id()
            .as_ref()
            .map(ToString::to_string),
        topic: Some(delivery.queue.clone()),
        partition: None,
        offset: Some(delivery.delivery_tag as i64),
        // AMQP 的时间戳是秒级，统一换算成毫秒。
        timestamp: delivery
            .properties
            .timestamp()
            .map(|seconds| (seconds as i64) * 1000),
        preview: crate::message::preview_of(&delivery.payload),
        size: Some(delivery.payload.len()),
        payload: Some(String::from_utf8_lossy(&delivery.payload).into_owned()),
    }
}

/// 由原始投递生成详情，附带 exchange / routing key 等 AMQP 专有信息。
pub fn detail_from_delivery(delivery: &RawDelivery) -> MessageDetail {
    let (text, base64) = crate::message::codec::decode_payload(&delivery.payload);

    let mut headers = crate::broker::rabbitmq::dto::headers_from_properties(&delivery.properties);
    headers.push(MessageHeader {
        key: "exchange".to_owned(),
        value: delivery.exchange.clone(),
    });
    headers.push(MessageHeader {
        key: "routingKey".to_owned(),
        value: delivery.routing_key.clone(),
    });

    MessageDetail {
        summary: summary_from_delivery(delivery),
        payload: text,
        payload_base64: base64,
        headers,
    }
}

/// 仅凭消息 ID 构造「无内容」的详情，用于前端本地取不到 payload 的兜底场景。
///
/// AMQP 在 `basic.reject(requeue = true)` 之后 deliveryTag 会重新分配，
/// 拿旧 tag 回源必然查不到，所以真正的内容应该随列表一起下发（见 `summary_from_delivery`），
/// 这里只保证接口有个语义正确的返回值，而不是 404。
pub fn placeholder_from_id(id: &str) -> AppResult<MessageDetail> {
    let (queue, tag) = parse_id(id)?;
    Ok(MessageDetail {
        summary: MessageSummary {
            id: id.to_owned(),
            key: None,
            topic: Some(queue),
            partition: None,
            offset: Some(tag as i64),
            timestamp: None,
            preview: "内容未随列表返回，请重新拉取队列".to_owned(),
            size: None,
            payload: None,
        },
        payload: String::new(),
        payload_base64: None,
        headers: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_id_keeps_queue_with_colon() {
        let (queue, tag) = parse_id("sys:logs:42").expect("解析失败");
        assert_eq!(queue, "sys:logs");
        assert_eq!(tag, 42);
    }

    #[test]
    fn parse_id_rejects_missing_tag() {
        assert!(parse_id("queue").is_err());
    }

    #[test]
    fn placeholder_keeps_id_and_queue() {
        let detail = placeholder_from_id("sys:logs:42").expect("构造失败");
        assert_eq!(detail.summary.id, "sys:logs:42");
        assert_eq!(detail.summary.topic.as_deref(), Some("sys:logs"));
        assert_eq!(detail.summary.offset, Some(42));
        assert!(detail.payload.is_empty());
    }

    #[test]
    fn placeholder_rejects_bad_id() {
        assert!(placeholder_from_id("queue").is_err());
    }
}
