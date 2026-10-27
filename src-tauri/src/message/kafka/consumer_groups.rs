//! Kafka 消费组查询：列表与详情。
//!
//! 查询本身是阻塞的（rdkafka 的 group / watermark 接口都是同步语义），
//! 统一放进 `spawn_blocking`，避免阻塞 Tauri 的异步运行时。

use std::sync::Arc;
use std::time::Duration;

use rdkafka::ClientConfig;
use rdkafka::consumer::BaseConsumer;

use crate::broker::kafka::KafkaClient;
use crate::broker::kafka::admin;
use crate::domain::{ConsumerGroupDetail, ConsumerGroupInfo, ConsumerGroupQuery};
use crate::error::{AppError, AppResult};

/// 组查询用的 consumer 建连超时上限，避免连接不可用时长时间挂起。
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

/// 列表结果。游标与 `has_more` 一起返回，前端原样回传即可翻页。
pub struct GroupPage {
    pub items: Vec<ConsumerGroupInfo>,
    pub has_more: bool,
    pub cursor: Option<String>,
}

/// 列出消费组，支持关键字过滤与游标翻页。
pub async fn list(
    client: &KafkaClient,
    query: ConsumerGroupQuery,
    limit: Option<usize>,
    cursor: Option<String>,
) -> AppResult<GroupPage> {
    let config = inspection_config(client, None);
    let worker = Arc::new(build(&config)?);
    let cursor = cursor.filter(|value| !value.is_empty());

    let (items, has_more, next_cursor) = tokio::task::spawn_blocking(move || {
        admin::fetch_groups(&worker, &query, limit, cursor.as_deref())
    })
    .await
    .map_err(|error| AppError::Internal(format!("消费组查询任务失败: {error}")))??;

    Ok(GroupPage {
        items,
        has_more,
        cursor: next_cursor,
    })
}

/// 读取单个消费组的成员与滞后明细。
pub async fn detail(client: &KafkaClient, group: &str) -> AppResult<ConsumerGroupDetail> {
    // 组名即 group.id：`committed_offsets` 只认当前 consumer 的 group.id。
    let config = inspection_config(client, Some(group));
    let worker = Arc::new(build(&config)?);
    let group = group.to_owned();

    tokio::task::spawn_blocking(move || admin::fetch_detail(&worker, &group))
        .await
        .map_err(|error| AppError::Internal(format!("消费组详情任务失败: {error}")))?
}

/// 面板侧查询用的 consumer 配置。
///
/// 开启 `enable.auto.commit = false`：面板只读，绝不能把位点写回业务组。
/// 以目标组名作为 group.id 是为了让 `committed_offsets` 能查到该组的位点。
fn inspection_config(client: &KafkaClient, group: Option<&str>) -> ClientConfig {
    inspection_config_from(
        client.consumer_config(group.unwrap_or("mqtui-inspect")),
        group,
    )
}

fn inspection_config_from(mut config: ClientConfig, group: Option<&str>) -> ClientConfig {
    config.set("group.id", group.unwrap_or("mqtui-inspect"));
    config
        .set("enable.auto.commit", "false")
        .set("socket.timeout.ms", CLIENT_TIMEOUT.as_millis().to_string());
    config
}

fn build(config: &ClientConfig) -> AppResult<BaseConsumer> {
    config.create().map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{KafkaAuth, KafkaConfig, TlsMode};

    fn config_for(group: Option<&str>) -> ClientConfig {
        let client = KafkaConfig {
            brokers: vec!["127.0.0.1:9092".to_owned()],
            tls: TlsMode::Disabled,
            auth: KafkaAuth::default(),
            options: Default::default(),
        };
        // 不用真连：`ClientConfig` 只是配置容器，`create` 才会建客户端。
        let mut base = ClientConfig::new();
        base.set("bootstrap.servers", client.brokers.join(","));
        inspection_config_from(base, group)
    }

    #[test]
    fn inspection_config_never_commits() {
        let config = config_for(Some("orders-worker"));
        assert_eq!(config.get("enable.auto.commit"), Some("false"));
        assert_eq!(config.get("group.id"), Some("orders-worker"));
    }

    #[test]
    fn inspection_config_falls_back_to_neutral_group() {
        let config = config_for(None);
        assert_eq!(config.get("group.id"), Some("mqtui-inspect"));
    }
}
