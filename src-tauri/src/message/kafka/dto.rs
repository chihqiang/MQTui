//! Kafka 消息与领域模型转换。

use rdkafka::Message;
use rdkafka::message::Headers;

use crate::domain::{MessageDetail, MessageHeader, MessageSummary, RawMessageHeader};
use crate::error::{AppError, AppResult};

/// 解析 `topic:partition:offset` 形式的消息 ID。
pub fn parse_id(id: &str) -> AppResult<(String, i32, i64)> {
    let mut parts = id.rsplitn(3, ':');
    let offset = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or_else(|| AppError::Invalid(format!("非法的消息 ID: {id}")))?;
    let partition = parts
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or_else(|| AppError::Invalid(format!("非法的消息 ID: {id}")))?;
    let topic = parts
        .next()
        .ok_or_else(|| AppError::Invalid(format!("非法的消息 ID: {id}")))?;
    Ok((topic.to_owned(), partition, offset))
}

pub fn message_id<M: Message>(message: &M) -> String {
    format!(
        "{}:{}:{}",
        message.topic(),
        message.partition(),
        message.offset()
    )
}

/// 由 rdkafka 消息生成列表摘要。
pub fn summary_from_message<M: Message>(message: &M) -> MessageSummary {
    let payload = message.payload().unwrap_or_default();

    MessageSummary {
        id: message_id(message),
        key: message
            .key()
            .map(|key| String::from_utf8_lossy(key).into_owned()),
        topic: Some(message.topic().to_owned()),
        partition: Some(message.partition()),
        offset: Some(message.offset()),
        timestamp: message.timestamp().to_millis(),
        preview: crate::message::preview_of(payload),
        size: Some(payload.len()),
        // Kafka 可以按 offset 精确回源，列表不必带全量内容。
        payload: None,
    }
}

/// 由 rdkafka 消息生成详情。
pub fn detail_from_message<M: Message>(message: &M) -> MessageDetail {
    let payload = message.payload().unwrap_or_default();
    let (text, base64) = crate::message::codec::decode_payload(payload);

    MessageDetail {
        summary: summary_from_message(message),
        payload: text,
        payload_base64: base64,
        // key 通常就是业务 ID，是文本；只有解不出 UTF-8 时才值得多发一份原始字节。
        key_base64: message.key().and_then(binary_key),
        headers: message
            .headers()
            .map(headers_to_headers)
            .unwrap_or_default(),
    }
}

/// 二进制 key 的 base64；文本 key 返回 `None`。
///
/// 判断标准与 `decode_payload` 一致：能当 UTF-8 读就不用管，读不出来才说明
/// 展平到字符串会改内容（`\xff` → `\u{fffd}`），重发得靠原始字节。
fn binary_key(key: &[u8]) -> Option<String> {
    if std::str::from_utf8(key).is_ok() {
        return None;
    }
    use base64::Engine;
    Some(base64::engine::general_purpose::STANDARD.encode(key))
}

/// rdkafka 的头集合转换为领域头列表（展示用）。
///
/// 用 `try_get` 而不是 `get`：后者在索引越界时 panic，而 headers 数量来自
/// broker，面板不该因为一条畸形消息把整个进程带下去。
fn headers_to_headers<H: Headers>(headers: &H) -> Vec<MessageHeader> {
    raw_headers(headers)
        .iter()
        .map(RawMessageHeader::to_header)
        .collect()
}

/// 原样抄下每个 header 的字节值。
///
/// 与 `headers_to_headers` 的区别只有一个，但很关键：`value: None` 的 header
/// **保留**，二进制值**不做** UTF-8 转换。重发要靠这份数据才能逐字节还原。
pub fn raw_headers<H: Headers>(headers: &H) -> Vec<RawMessageHeader> {
    (0..headers.count())
        .filter_map(|index| headers.try_get(index))
        .map(|header| RawMessageHeader {
            key: header.key.to_owned(),
            value: header.value.map(<[u8]>::to_vec),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_id_roundtrip() {
        let (topic, partition, offset) = parse_id("orders:3:1024").expect("解析失败");
        assert_eq!(topic, "orders");
        assert_eq!(partition, 3);
        assert_eq!(offset, 1024);
    }

    #[test]
    fn parse_id_supports_topic_with_colon() {
        let (topic, partition, offset) = parse_id("ns:orders:0:7").expect("解析失败");
        assert_eq!(topic, "ns:orders");
        assert_eq!(partition, 0);
        assert_eq!(offset, 7);
    }

    #[test]
    fn parse_id_rejects_garbage() {
        assert!(parse_id("orders").is_err());
    }
}
