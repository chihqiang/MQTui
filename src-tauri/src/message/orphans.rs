//! 无消费组主题的跨中间件入口。
//!
//! 该能力只有 Kafka 有（AMQP 的队列本身就是消费单位），
//! 这里把「不支持」收敛成统一错误，命令层不必直接 match 中间件类型。

use crate::domain::BrokerKind;
use crate::error::AppError;

/// 能力不可用时的统一错误。
pub fn unsupported() -> AppError {
    AppError::Unsupported("当前连接不是 Kafka，无消费组主题查询不可用".to_owned())
}

/// 判断某个中间件是否支持该能力，命令层用它做前置校验。
pub fn supports(kind: BrokerKind) -> bool {
    matches!(kind, BrokerKind::Kafka)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_kafka_supports_orphan_topics() {
        assert!(supports(BrokerKind::Kafka));
        assert!(!supports(BrokerKind::RabbitMq));
    }
}
