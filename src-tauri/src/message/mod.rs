//! 消息层：消息列表、详情、发送。
//!
//! 与 `broker` 同样的组织方式：一个中间件一个子模块，
//! `dto.rs` 负责把驱动数据翻译成领域模型，模块根负责编排。
//! `codec.rs` 放与中间件无关的 payload 处理。

pub mod codec;
pub mod consumer;
pub mod kafka;
pub mod orphans;
pub mod rabbitmq;

/// 预览内容的最大字符数，详情接口返回完整内容。
pub const PREVIEW_LIMIT: usize = 240;
/// 单次最多返回的消息条数，防止把整个 topic 拉满内存。
pub const MAX_MESSAGE_LIMIT: usize = 500;
/// 默认返回条数。
pub const DEFAULT_MESSAGE_LIMIT: usize = 100;

/// 裁剪查询条数到允许范围。
pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_MESSAGE_LIMIT)
        .clamp(1, MAX_MESSAGE_LIMIT)
}

/// 生成列表预览：尽量按字符（而非字节）截断，避免把 UTF-8 截断成乱码。
pub fn preview_of(payload: &[u8]) -> String {
    let text = String::from_utf8_lossy(payload);
    let mut preview: String = text.chars().take(PREVIEW_LIMIT).collect();
    if text.chars().count() > PREVIEW_LIMIT {
        preview.push('…');
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_uses_default_when_missing() {
        assert_eq!(clamp_limit(None), DEFAULT_MESSAGE_LIMIT);
    }

    #[test]
    fn clamp_respects_upper_bound() {
        assert_eq!(clamp_limit(Some(usize::MAX)), MAX_MESSAGE_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
    }

    #[test]
    fn preview_handles_multibyte() {
        let payload = "中文".repeat(PREVIEW_LIMIT);
        let preview = preview_of(payload.as_bytes());
        assert!(preview.ends_with('…'));
        assert_eq!(preview.chars().count(), PREVIEW_LIMIT + 1);
    }
}
