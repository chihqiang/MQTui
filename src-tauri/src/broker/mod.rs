//! 连接层：负责与消息中间件建立连接，并在内存中维护连接池。
//!
//! 每个中间件一个子模块，模块内的 `client.rs` 封装驱动，
//! `dto.rs` 负责领域模型与驱动模型之间的转换。

pub mod kafka;
pub mod rabbitmq;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::domain::{BrokerKind, ConnectionConfig, ConnectionId, ConnectionSummary, Overview};
use crate::error::{AppError, AppResult};

/// 已建立的连接。新增中间件时在此枚举里补充分支即可。
pub enum Connection {
    Kafka(kafka::KafkaClient),
    RabbitMq(rabbitmq::RabbitMqClient),
}

impl Connection {
    pub fn kind(&self) -> BrokerKind {
        match self {
            Self::Kafka(_) => BrokerKind::Kafka,
            Self::RabbitMq(_) => BrokerKind::RabbitMq,
        }
    }

    /// 取 Kafka 客户端，类型不匹配时返回明确错误。
    pub fn as_kafka(&self) -> AppResult<&kafka::KafkaClient> {
        match self {
            Self::Kafka(client) => Ok(client),
            other => Err(AppError::Unsupported(format!(
                "当前连接是 {}，不支持 Kafka 操作",
                other.kind().display_name()
            ))),
        }
    }

    /// 取 RabbitMQ 客户端，类型不匹配时返回明确错误。
    pub fn as_rabbitmq(&self) -> AppResult<&rabbitmq::RabbitMqClient> {
        match self {
            Self::RabbitMq(client) => Ok(client),
            other => Err(AppError::Unsupported(format!(
                "当前连接是 {}，不支持 RabbitMQ 操作",
                other.kind().display_name()
            ))),
        }
    }
}

/// 连接池中的一条记录。
struct Entry {
    summary: ConnectionSummary,
    connection: Arc<Connection>,
}

/// 连接池：进程内共享，使用 `RwLock` 保护。
#[derive(Default)]
pub struct ConnectionRegistry {
    entries: RwLock<HashMap<ConnectionId, Entry>>,
}

impl ConnectionRegistry {
    /// 建立连接并登记。
    pub async fn open(
        &self,
        name: String,
        config: ConnectionConfig,
    ) -> AppResult<ConnectionSummary> {
        config.validate().map_err(AppError::Invalid)?;

        let id = ConnectionId::new();
        let connection = match config.clone() {
            ConnectionConfig::Kafka(kafka) => {
                Connection::Kafka(kafka::KafkaClient::connect(kafka).await?)
            }
            ConnectionConfig::RabbitMq(rabbitmq) => {
                Connection::RabbitMq(rabbitmq::RabbitMqClient::connect(rabbitmq).await?)
            }
        };

        let summary = ConnectionSummary {
            id: id.clone(),
            name,
            kind: connection.kind(),
            endpoint: config.endpoint(),
            active: true,
        };

        let mut entries = self.entries.write().await;
        entries.insert(
            id,
            Entry {
                summary: summary.clone(),
                connection: Arc::new(connection),
            },
        );
        Ok(summary)
    }

    /// 列出全部连接。
    pub async fn list(&self) -> Vec<ConnectionSummary> {
        let entries = self.entries.read().await;
        let mut items: Vec<_> = entries
            .values()
            .map(|entry| entry.summary.clone())
            .collect();
        items.sort_by(|a, b| a.name.cmp(&b.name));
        items
    }

    /// 按 ID 取连接句柄。
    pub async fn get(&self, id: &ConnectionId) -> AppResult<Arc<Connection>> {
        let entries = self.entries.read().await;
        entries
            .get(id)
            .map(|entry| Arc::clone(&entry.connection))
            .ok_or_else(|| AppError::NotFound(format!("连接 {id}")))
    }

    /// 关闭并移除连接。
    pub async fn close(&self, id: &ConnectionId) -> AppResult<()> {
        let mut entries = self.entries.write().await;
        entries
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| AppError::NotFound(format!("连接 {id}")))
    }
}

/// 各中间件的概览信息。
pub async fn overview(connection: &Connection) -> AppResult<Overview> {
    match connection {
        Connection::Kafka(client) => client.overview().await,
        Connection::RabbitMq(client) => client.overview().await,
    }
}
