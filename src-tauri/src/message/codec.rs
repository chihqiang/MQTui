//! payload 的通用编码转换。
//!
//! 这一段与具体中间件无关：Kafka 与 RabbitMQ 的消息体都是裸字节，
//! 展示层的处理方式完全一致，放在这里避免一个中间件模块去引用另一个。

use base64::Engine;

/// 最大努力把 payload 解码成 UTF-8 文本；非文本内容额外附带 base64。
pub fn decode_payload(payload: &[u8]) -> (String, Option<String>) {
    match std::str::from_utf8(payload) {
        Ok(text) => (text.to_owned(), None),
        Err(_) => (
            String::from_utf8_lossy(payload).into_owned(),
            Some(base64::engine::general_purpose::STANDARD.encode(payload)),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_payload_has_no_base64() {
        let (text, base64) = decode_payload("中文".as_bytes());
        assert_eq!(text, "中文");
        assert!(base64.is_none());
    }

    #[test]
    fn binary_payload_keeps_base64() {
        let (_, base64) = decode_payload(&[0xff, 0xfe]);
        assert_eq!(base64.as_deref(), Some("//4="));
    }
}
