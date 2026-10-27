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

/// 消息定位条件：在 Kafka 日志里按 key 或时间区间找消息。
///
/// `key` 与 `after` / `before` 取交集：既填 key 又填时间区间时，两个条件都要满足。
/// 为空串的 key 视为「不按 key 过滤」——表单里清空输入不该变成「找 key 为空的消息」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLocate {
    pub connection_id: String,
    /// Kafka 主题名。
    pub target: String,
    /// 按消息 key 精确匹配。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// 时间区间起点（毫秒时间戳，含）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<i64>,
    /// 时间区间终点（毫秒时间戳，含）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
    /// 按消息内容（payload）包含匹配。
    ///
    /// 与 `key` 的语义刻意不同：key 是「这条消息在哪」的坐标，必须精确；
    /// 内容是「这里面提到了什么」，只能是包含匹配，且不区分大小写。
    /// 但这是一次逐条解码的扫描，代价远高于 key 定位，因此必须有一个
    /// 时间区间或明确的确认才能发起（见 `locate::max_content_scan`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 最多返回条数，后端会做上限裁剪。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 上一页返回的续扫游标，原样回传表示「沿上次停下的位置继续」。
    ///
    /// 缺省表示从头开始。游标里记录了每个分区读到哪、以及原始条件指纹，
    /// 所以换条件后会失效（见 `locate::cursor`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// 定位结果。
///
/// 除了命中列表，还回报「扫了多少」和「为什么停下」，否则用户无法判断
/// 「筛出来 3 条」是日志里只有 3 条，还是只翻到了 3 条就放弃了。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearch {
    /// 命中的消息，同一页内按时间倒序。
    pub items: Vec<MessageSummary>,
    /// 实际解码过的消息条数（含未命中的）。
    pub scanned: u64,
    /// 是否因为到达扫描上限或时间区间边界而提前结束。
    pub truncated: bool,
    /// 扫描区间说明，例如「按时间区间 [..] 从最早位置开始扫描」。
    pub note: String,
    /// 续扫游标。为 `None` 表示已经读到日志尽头，没有更多可读了。
    ///
    /// 前端不该自己判断「还有没有」，它看不到分区状态；
    /// 这里给出断言，前端只负责把它回传。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// 本次扫描起点的说明，例如「从上次停下的位置继续」。首页为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
    /// 内容扫描被条数上限提前终止时为 `true`，附一句人话说明。
    ///
    /// 与 `truncated` 分开：那个表示「这一轮没扫完」，这个表示
    /// 「按内容扫描的规则，这一轮只允许扫到这里」。合并成一个字段，
    /// 用户就分不清「再点一次能继续」和「再点一次也扫不动」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_budget: Option<String>,
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
