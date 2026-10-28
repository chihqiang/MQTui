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
use rdkafka::message::Message;

use crate::broker::kafka::KafkaClient;
use crate::broker::kafka::client::DeliveryReceipt;
use crate::domain::resend::{OriginalMessage, build_plan, compare_partition};
use crate::domain::{ResendOutcome, ResendRequest};
use crate::error::{AppError, AppResult};

use super::dto::{parse_id, raw_headers};

/// 单次回源的等待时间。
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 重发一条消息。
pub async fn resend(client: &KafkaClient, request: &ResendRequest) -> AppResult<ResendOutcome> {
    let original = read_original(client, &request.message_id).await?;
    let plan = build_plan(&original, request).map_err(|block| AppError::Invalid(block.reason()))?;

    let receipt = client
        .deliver(
            &plan.topic,
            plan.key_bytes.as_deref(),
            &plan.payload,
            &plan.headers,
        )
        .await?;

    // 没确认写入的两种结果都不是「成功」：`NotSent` 说清没发出去、重试安全；
    // `Unsure` 连同「可能已写入、别再点」一起交给界面。把它们塞进 note 里
    // 假装成功，用户看到的就是「已写入 分区 null offset null」。
    let (partition, offset) = match receipt.landed() {
        Some(landed) => landed,
        None => {
            return Err(match receipt {
                DeliveryReceipt::NotSent(reason) => AppError::Broker(reason),
                other => AppError::Broker(other.message(&plan.topic)),
            });
        }
    };

    let check = compare_partition(&plan, partition);
    let note = check
        .message()
        .unwrap_or_else(|| format!("已写进 {} 分区 {partition}", plan.topic));

    Ok(ResendOutcome {
        topic: plan.topic,
        partition,
        offset,
        note,
        // 重发这条路径最需要这句话：幂等失效时，「再发一次」正是重复消息的来源，
        // 而界面这一屏的全部意义就是「再发一次会怎样」。
        warning: client.guarantee().warning(),
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
                // key 保留原始字节：key 只参与分区哈希，不必是 UTF-8。
                // lossy 一转，`\xff` 变成 `\u{fffd}`，同一个 key 就落到了别的分区上——
                // 而「同一条 key 是不是还落在原分区」正是重发要验证的东西。
                key: message.key().map(<[u8]>::to_vec),
                // 同时给一份文本：它只在「用户自己没动 key 但表单要显示」时有用。
                key_text: message
                    .key()
                    .map(|key| String::from_utf8_lossy(key).into_owned()),
                payload: message.payload().unwrap_or_default().to_vec(),
                headers: message.headers().map(raw_headers).unwrap_or_default(),
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
