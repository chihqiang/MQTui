//! 消费组查询的跨中间件入口。
//!
//! 消费组目前只有 Kafka 有，但命令层不该直接 `match` 中间件类型；
//! 这里按「能力」把不支持的中间件收敛成一条明确的错误提示。

use crate::domain::{ConsumerGroupInfo, ConsumerGroupQuery};
use crate::error::AppError;

use super::kafka::consumer_groups;

/// 消费组列表结果。分页语义与消息列表一致：游标原样回传给前端。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupPage {
    pub items: Vec<ConsumerGroupInfo>,
    pub has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

impl From<consumer_groups::GroupPage> for ConsumerGroupPage {
    fn from(page: consumer_groups::GroupPage) -> Self {
        Self {
            items: page.items,
            has_more: page.has_more,
            cursor: page.cursor,
        }
    }
}

/// 消费组能力不可用时的统一错误。
pub fn unsupported() -> AppError {
    AppError::Unsupported("当前连接不是 Kafka，消费组功能不可用".to_owned())
}

/// 判断某个中间件是否支持消费组。命令层用它做前置校验。
pub fn supports(kind: crate::domain::BrokerKind) -> bool {
    matches!(kind, crate::domain::BrokerKind::Kafka)
}

/// 供命令层复用的查询构造：把「可选参数」统一成后端语义。
pub fn query(keyword: Option<String>) -> ConsumerGroupQuery {
    ConsumerGroupQuery {
        keyword: keyword
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::BrokerKind;

    #[test]
    fn only_kafka_supports_consumer_groups() {
        assert!(supports(BrokerKind::Kafka));
        assert!(!supports(BrokerKind::RabbitMq));
    }

    #[test]
    fn blank_keyword_is_dropped() {
        assert!(query(Some("   ".to_owned())).keyword.is_none());
        assert!(query(None).keyword.is_none());
        assert_eq!(
            query(Some(" orders ".to_owned())).keyword.as_deref(),
            Some("orders")
        );
    }
}
