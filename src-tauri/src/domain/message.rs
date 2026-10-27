//! 消息相关的领域模型。

use serde::{Deserialize, Serialize};

use crate::domain::BrokerKind;

/// 消息列表查询条件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
    pub connection_id: String,
    /// Kafka 对应 topic，RabbitMQ 对应 queue。
    pub target: String,
    /// 最多返回条数，后端会做上限裁剪。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 上一页返回的游标，前端原样回传表示「加载更多」；缺省表示从头读。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// 列表中的消息摘要，只包含渲染列表必需的信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    /// 消息在列表中的稳定标识，用于拉取详情。
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partition: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    /// 毫秒时间戳，缺失时由前端显示 `-`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// 截断后的内容预览，详情接口返回完整内容。
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<usize>,
    /// 完整 payload（UTF-8 最佳努力解码）。仅 RabbitMQ 填充。
    ///
    /// AMQP 的 deliveryTag 在 `basic.reject(requeue = true)` 之后会被重新分配，
    /// 列表里的 ID 事后回源查不到，因此消息内容只能随列表一起下发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
}

/// 消息详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub summary: MessageSummary,
    /// 原始 payload，已按 UTF-8 最佳努力解码；二进制内容以 base64 附带。
    pub payload: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_base64: Option<String>,
    pub headers: Vec<MessageHeader>,
}

/// 消息头键值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHeader {
    pub key: String,
    pub value: String,
}

/// 分页结果。具体中间件的分页语义不同，这里只统一承载形态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub items: Vec<MessageSummary>,
    /// 是否还有更多数据（Kafka 通过 offset 游标判断）。
    pub has_more: bool,
    /// 下一页游标，前端原样回传。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 当前数据来源的展示名（topic / queue）。
    pub source: String,
}

/// 发送消息请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub connection_id: String,
    /// Kafka 为 topic，RabbitMQ 为 routing key。
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub payload: String,
    #[serde(default)]
    pub headers: Vec<MessageHeader>,
    /// RabbitMQ 需要指定交换机；Kafka 忽略该字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange: Option<String>,
}

/// 发送结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub kind: BrokerKind,
    /// 中间件返回的确认信息，例如 Kafka 的 partition/offset。
    pub detail: String,
}
