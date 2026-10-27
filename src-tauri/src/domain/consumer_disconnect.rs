//! 断开消费者的判定规则。
//!
//! 「断掉一个消费者」是面板里最危险的一类操作之一：它不像删队列那样会被 `if-empty`
//! 之类的服务端约束挡一下——服务端会照做，而且对端正在跑业务的服务会立刻开始丢失消费能力、
//! 甚至进入重连风暴。所以这里把「该不该给这个按钮、给了要提示什么」收成纯函数，
//! 而不是让界面凭感觉渲染。
//!
//! 规则刻意保守：默认全部**不允许**，只有明确满足条件才放行。

use serde::{Deserialize, Serialize};

use super::QueueConsumer;

/// 断开判定的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DisconnectVerdict {
    /// 可以断开，但仍需二次确认。
    Allowed,
    /// 消费者 tag 是服务端自动生成的语义前缀之外的临时值，定位不到具体目标。
    UnknownTarget,
    /// 该消费者属于面板自己（MQTui 预览消息时创建的临时消费者）。
    OwnedByPanel,
    /// 消费者正在处理消息：未确认数 > 0，断开会让这些消息回队并可能被重复投递。
    InFlight,
}

impl DisconnectVerdict {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    /// 给用户的说明。`Allowed` 也有一句提示——允许不等于安全。
    pub fn note(self) -> &'static str {
        match self {
            Self::Allowed => {
                "断开后对端服务会立刻失去该消费者，未确认消息会回到队列并可能被重复投递"
            }
            Self::UnknownTarget => "消费者标签不合法，无法定位到具体目标",
            Self::OwnedByPanel => "这是面板自己的临时消费者，不应手动断开",
            Self::InFlight => "该消费者还有未确认消息在手上，断开会导致消息回队并被重复消费",
        }
    }
}

/// 面板自己创建的消费者 tag 前缀。
///
/// 预览消息、定位消息都会建临时消费者，它们的 tag 是我们自己起的名字。
/// 在界面上把这些当作「业务消费者」断开毫无意义，只会让面板自己的操作失败。
pub const PANEL_TAG_PREFIX: &str = "mqtui";

/// 判断一个消费者能否被断开。
pub fn evaluate(consumer: &QueueConsumer) -> DisconnectVerdict {
    let tag = consumer.consumer_tag.trim();
    // 空 tag 或含控制字符：管理 API 的路径里塞不进去，也定位不到。
    if tag.is_empty() || tag.contains('/') || tag.chars().any(char::is_control) {
        return DisconnectVerdict::UnknownTarget;
    }
    if tag.starts_with(PANEL_TAG_PREFIX) {
        return DisconnectVerdict::OwnedByPanel;
    }
    // 有未确认消息说明它正在干活：断开等于强行打断一次业务处理。
    if consumer.messages_unacknowledged > 0 {
        return DisconnectVerdict::InFlight;
    }
    DisconnectVerdict::Allowed
}

/// 断开消费者的请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub connection_id: String,
    /// 消费者所属队列，仅用于提示与复核。
    pub queue: String,
    /// 服务端分配的 consumer tag。
    pub consumer_tag: String,
    /// 用户输入以确认这次操作的队列名。与 `queue` 不一致就整单拒绝。
    ///
    /// 断开不可撤销，且误踢一个跑业务的服务代价可能远大于误删队列
    /// （队列删了还能重建，消费者被踢会引发对端重连，甚至触发消息重复消费）。
    /// 所以要求用户手打队列名——和危险操作确认输入的做法一致。
    #[serde(default)]
    pub confirm: String,
}

impl DisconnectRequest {
    /// 校验。返回的错误文案可直接展示。
    pub fn validate(&self) -> Result<(), String> {
        if self.consumer_tag.trim().is_empty() {
            return Err("消费者标签不能为空".to_owned());
        }
        let expected = self.queue.trim();
        if expected.is_empty() {
            return Err("队列名不能为空".to_owned());
        }
        if self.confirm.trim() != expected {
            return Err(format!("请完整输入队列名 `{expected}` 以确认断开"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consumer(tag: &str, unacked: u64) -> QueueConsumer {
        QueueConsumer {
            queue: "orders".to_owned(),
            consumer_tag: tag.to_owned(),
            connection_name: Some("svc-a".to_owned()),
            channel: None,
            username: "app".to_owned(),
            ack_required: true,
            prefetch_count: 10,
            messages_unacknowledged: unacked,
        }
    }

    #[test]
    fn idle_consumer_can_be_disconnected() {
        assert_eq!(
            evaluate(&consumer("amq.ctag-abc123", 0)),
            DisconnectVerdict::Allowed
        );
        assert!(DisconnectVerdict::Allowed.is_allowed());
    }

    #[test]
    fn in_flight_messages_block_disconnect() {
        assert_eq!(
            evaluate(&consumer("amq.ctag-abc123", 1)),
            DisconnectVerdict::InFlight
        );
    }

    #[test]
    fn panel_owned_consumers_are_not_ours_to_kill() {
        assert_eq!(
            evaluate(&consumer("mqtui-preview-42", 0)),
            DisconnectVerdict::OwnedByPanel
        );
    }

    #[test]
    fn unusable_tags_are_rejected() {
        assert_eq!(
            evaluate(&consumer("  ", 0)),
            DisconnectVerdict::UnknownTarget
        );
        // `/` 会破坏管理 API 的路径结构。
        assert_eq!(
            evaluate(&consumer("amq.ctag/a", 0)),
            DisconnectVerdict::UnknownTarget
        );
        assert_eq!(
            evaluate(&consumer("amq.ctag-\u{1}", 0)),
            DisconnectVerdict::UnknownTarget
        );
    }

    #[test]
    fn every_verdict_has_a_note() {
        for verdict in [
            DisconnectVerdict::Allowed,
            DisconnectVerdict::UnknownTarget,
            DisconnectVerdict::OwnedByPanel,
            DisconnectVerdict::InFlight,
        ] {
            assert!(!verdict.note().is_empty(), "{verdict:?}");
        }
    }

    fn request(queue: &str, tag: &str, confirm: &str) -> DisconnectRequest {
        DisconnectRequest {
            connection_id: "c1".to_owned(),
            queue: queue.to_owned(),
            consumer_tag: tag.to_owned(),
            confirm: confirm.to_owned(),
        }
    }

    #[test]
    fn confirm_must_match_queue_name() {
        assert!(request("orders", "amq.ctag-a", "orders").validate().is_ok());
        // 前后空格无害，但拼错一个字符就必须拒绝。
        assert!(
            request("orders", "amq.ctag-a", " orders ")
                .validate()
                .is_ok()
        );
        assert!(request("orders", "amq.ctag-a", "order").validate().is_err());
        assert!(request("orders", "amq.ctag-a", "").validate().is_err());
    }

    #[test]
    fn blank_fields_are_rejected() {
        assert!(request(" ", "amq.ctag-a", " ").validate().is_err());
        assert!(request("orders", "  ", "orders").validate().is_err());
    }
}
