//! Kafka 客户端封装：只暴露面板需要的少量能力，屏蔽 librdkafka 细节。

use std::sync::Arc;
use std::time::Duration;

use rdkafka::ClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;

use crate::domain::{
    CheckStatus, HealthCheck, HealthReport, KafkaConfig, KeyValue, Overview, TopicInfo,
};
use crate::error::{AppError, AppResult};

use super::dto::client_config;

/// 元数据请求超时。
const META_TIMEOUT: Duration = Duration::from_secs(10);

/// Kafka 客户端。
///
/// `BaseConsumer` 不是 `Sync`，因此内部统一用 `Arc` 包裹并在使用时独占访问。
pub struct KafkaClient {
    config: ClientConfig,
    bootstrap: String,
    admin: Arc<BaseConsumer>,
    producer: FutureProducer,
}

impl KafkaClient {
    /// 建立连接：创建 admin 消费者并拉取一次元数据，失败即视为连接不可用。
    pub async fn connect(config: KafkaConfig) -> AppResult<Self> {
        let base = client_config(&config);
        let bootstrap = config.brokers.join(",");

        let build = |base: &ClientConfig| -> AppResult<(BaseConsumer, FutureProducer)> {
            let admin: BaseConsumer = base.create()?;
            let producer: FutureProducer = base.create()?;
            Ok((admin, producer))
        };

        let (admin, producer) = build(&base)?;
        let admin = Arc::new(admin);

        // 元数据请求是阻塞调用，放到阻塞线程池，避免卡住 Tauri 的异步运行时。
        let probe = Arc::clone(&admin);
        let result = tokio::task::spawn_blocking(move || {
            probe.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 元数据任务失败: {error}")))?;
        result.map_err(|error| AppError::Connect(format!("{bootstrap}: {error}")))?;

        Ok(Self {
            config: base,
            bootstrap,
            admin,
            producer,
        })
    }

    /// 概览信息。
    pub async fn overview(&self) -> AppResult<Overview> {
        let admin = Arc::clone(&self.admin);
        let metadata = tokio::task::spawn_blocking(move || {
            admin.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 元数据任务失败: {error}")))?
        .map_err(AppError::from)?;

        let items = vec![
            KeyValue::new("Brokers", self.bootstrap.clone()),
            KeyValue::new("集群 ID", metadata.orig_broker_id().to_string()),
            KeyValue::new("节点数", metadata.brokers().len().to_string()),
            KeyValue::new("主题数", metadata.topics().len().to_string()),
        ];

        Ok(Overview {
            title: "Kafka 集群".to_owned(),
            items,
        })
    }

    /// 订阅主题列表。
    pub async fn topics(&self) -> AppResult<Vec<TopicInfo>> {
        let admin = Arc::clone(&self.admin);
        let metadata = tokio::task::spawn_blocking(move || {
            admin.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 元数据任务失败: {error}")))?
        .map_err(AppError::from)?;

        Ok(metadata
            .topics()
            .iter()
            .map(|topic| TopicInfo {
                name: topic.name().to_owned(),
                partitions: topic.partitions().len(),
                // 取第一个分区的副本数作为主题副本因子，服务端重启期间可能缺失。
                replication_factor: topic
                    .partitions()
                    .first()
                    .map(|partition| partition.replicas().len()),
            })
            .collect())
    }

    /// 发送一条消息，返回 `partition@offset` 形式的确认信息。
    pub async fn send(
        &self,
        topic: &str,
        key: Option<&str>,
        payload: &[u8],
        headers: &[(String, String)],
    ) -> AppResult<String> {
        let mut record = FutureRecord::<str, [u8]>::to(topic).payload(payload);
        if let Some(key) = key {
            record = record.key(key);
        }

        let owned_headers = headers.iter().fold(
            rdkafka::message::OwnedHeaders::new(),
            |headers, (name, value)| {
                headers.insert(rdkafka::message::Header {
                    key: name.as_str(),
                    value: Some(value.as_bytes()),
                })
            },
        );
        record = record.headers(owned_headers);

        let delivery = self
            .producer
            .send(record, Timeout::After(META_TIMEOUT))
            .await
            .map_err(|(error, _)| AppError::from(error))?;

        Ok(format!(
            "partition={} offset={}",
            delivery.partition, delivery.offset
        ))
    }

    /// 健康检查：bootstrap 可达 + 元数据可取。
    ///
    /// Kafka 没有「管理 API 写权限」这种概念（权限由 ACL 决定，查看 ACL 要另开 AdminClient），
    /// 所以只报告两项。`writeAccess` 留给 RabbitMQ，前端按 key 判断按钮状态，
    /// 不必为「Kafka 没有这一项」写特例。
    pub async fn health(&self) -> AppResult<HealthReport> {
        let admin = Arc::clone(&self.admin);
        let probe = tokio::task::spawn_blocking(move || {
            admin.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 健康检查任务失败: {error}")))?;

        let item = match probe {
            Ok(metadata) => HealthCheck::new("metadata", "元数据请求", CheckStatus::Ok)
                .with_detail(format!(
                    "{} 个 topic / {} 个节点",
                    metadata.topics().len(),
                    metadata.brokers().len()
                )),
            Err(error) => HealthCheck::new("metadata", "元数据请求", CheckStatus::Failed)
                .with_detail(error.to_string()),
        };

        Ok(HealthReport {
            items: vec![
                HealthCheck::new("bootstrap", "Bootstrap", CheckStatus::Ok)
                    .with_detail(self.bootstrap.clone()),
                item,
            ],
            checked_at: now_millis(),
        })
    }

    /// 供上层构造 consumer 使用的基础配置。
    pub fn consumer_config(&self, group_id: &str) -> ClientConfig {
        let mut config = self.config.clone();
        config
            .set("group.id", group_id)
            .set("enable.auto.commit", "false")
            .set("auto.offset.reset", "earliest");
        config
    }

    /// bootstrap 地址，用于错误提示。
    pub fn bootstrap(&self) -> &str {
        &self.bootstrap
    }
}

/// 毫秒时间戳，与 RabbitMQ 侧保持同一种时间刻度。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}
