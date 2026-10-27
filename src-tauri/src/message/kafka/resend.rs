//! Kafka 消息重发。
//!
//! 与 RabbitMQ 的「重投」不是一回事：Kafka 的消息按 offset 存在分区日志里，
//! 无法就地移动或复制到别处，重发只能是**往日志里再写一条新消息**。
//! 所以这里的目标不是「把消息还回去」，而是「用同样的 key / 内容再发一次」，
//! 顺带验证 key 是否还落在原来的分区。
//!
//! 流程只有两步：按 ID 精确回源读原消息 → 组装计划 → produce。
//! 组装规则与校验在 `domain::resend`，这里只负责把 broker 的数据喂进去。

use rdkafka::Offset;
use rdkafka::TopicPartitionList;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::message::{Headers, Message};

use crate::broker::kafka::KafkaClient;
use crate::domain::resend::{OriginalMessage, build_plan, compare_partition};
use crate::domain::{MessageHeader, ResendOutcome, ResendRequest};
use crate::error::{AppError, AppResult};

use super::dto::parse_id;

/// 单次回源的等待时间。
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 重发一条消息。
pub async fn resend(client: &KafkaClient, request: &ResendRequest) -> AppResult<ResendOutcome> {
    let original = read_original(client, &request.message_id).await?;
    let plan = build_plan(&original, request).map_err(|block| AppError::Invalid(block.reason()))?;

    let headers: Vec<(String, String)> = plan
        .headers
        .iter()
        .map(|header| (header.key.clone(), header.value.clone()))
        .collect();

    let receipt = client
        .deliver(&plan.topic, plan.key.as_deref(), &plan.payload, &headers)
        .await?;

    let check = compare_partition(&plan, receipt.partition);
    let note = check
        .message()
        .unwrap_or_else(|| format!("已写进 {} 分区 {}", plan.topic, receipt.partition));

    Ok(ResendOutcome {
        topic: plan.topic,
        partition: receipt.partition,
        offset: receipt.offset,
        note,
    })
}

/// 按 `topic:partition:offset` 精确回源读取原消息。
///
/// Kafka 的 offset 是稳定的，回源不会像 AMQP 的 deliveryTag 那样漂移，
/// 所以这里可以放心「再读一遍原消息」而不是依赖列表带过来的内容。
async fn read_original(client: &KafkaClient, message_id: &str) -> AppResult<OriginalMessage> {
    let (topic, partition, offset) = parse_id(message_id)?;
    let message_id = message_id.to_owned();

    let config = client.consumer_config(&format!("mqtui-resend-{}", uuid::Uuid::new_v4()));
    let consumer: BaseConsumer = config.create().map_err(AppError::from)?;

    tokio::task::spawn_blocking(move || -> AppResult<OriginalMessage> {
        let mut assignments = TopicPartitionList::with_capacity(1);
        assignments
            .add_partition_offset(&topic, partition, Offset::Offset(offset))
            .map_err(AppError::from)?;
        consumer.assign(&assignments).map_err(AppError::from)?;

        match consumer.poll(FETCH_TIMEOUT) {
            Some(Ok(message)) => Ok(OriginalMessage {
                topic: message.topic().to_owned(),
                partition: Some(message.partition()),
                key: message
                    .key()
                    .map(|key| String::from_utf8_lossy(key).into_owned()),
                payload: message.payload().unwrap_or_default().to_vec(),
                headers: headers_of(&message),
            }),
            Some(Err(error)) => Err(AppError::from(error)),
            // 读不到通常是日志清理把这段裁掉了。说清原因，别让人以为是 ID 写错。
            None => Err(AppError::NotFound(format!(
                "{message_id}（可能已被 retention 清理）"
            ))),
        }
    })
    .await
    .map_err(|error| AppError::Internal(format!("Kafka 重发任务失败: {error}")))?
}

/// 读出消息的 headers。
///
/// 用 `try_get` 而不是 `get`：后者索引越界会 panic，header 数量来自 broker，
/// 不该因为一条畸形消息把整个进程带下去。
fn headers_of<M: Message>(message: &M) -> Vec<MessageHeader> {
    let Some(headers) = message.headers() else {
        return Vec::new();
    };
    (0..headers.count())
        .filter_map(|index| headers.try_get(index))
        .filter_map(|header| {
            let value = header.value?;
            Some(MessageHeader {
                key: header.key.to_owned(),
                value: String::from_utf8_lossy(value).into_owned(),
            })
        })
        .collect()
}
