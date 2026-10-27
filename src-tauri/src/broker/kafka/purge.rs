//! 主题级写操作：清空分区、按时间删记录、删消费组。
//!
//! 这些都是「面板到这一步才算真能动手」的能力。此前要清一个主题里的脏数据
//! 只能回终端敲 `kafka-topics.sh` —— 而用户刚刚是在面板上看见这堆脏数据的。
//!
//! 两个 API 有一个共同点，和「建主题」不同：**它们是部分成功的**。
//! 一批分区里有几个的 leader 正在迁移时，服务端会逐条返回错误，其余照常提交。
//! 所以这里的返回类型不是 `Result<(), AppError>`，而是「每个分区一条结果」——
//! 合并成一个错误会让用户以为一条都没删。

use rdkafka::Offset;
use rdkafka::admin::AdminClient;
use rdkafka::client::DefaultClientContext;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::topic_partition_list::TopicPartitionList;
use rdkafka::util::Timeout;

use crate::domain::{KeyValue, PurgeOutcome, PurgePlan};
use crate::error::{AppError, AppResult};

use super::topics::ADMIN_TIMEOUT;

/// 时间戳反查的超时。它只问 leader 一个问题，不需要很久。
const SEEK_TIMEOUT: Timeout = Timeout::After(std::time::Duration::from_secs(10));

/// 单个分区的删除结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionPurgeResult {
    pub partition: i32,
    /// 失败原因；`None` 表示成功。
    pub error: Option<String>,
}

/// 按时间反查分区边界：返回「第一条不早于 `before` 的消息」的位点。
///
/// Kafka 的 `ListOffsets` 语义就是这样，而删记录要的是「早于该时间的都删掉」，
/// 两者正好对齐 —— 不需要 ±1 的修正。这点值得写下来，因为差一位的删除
/// 在界面上完全看不出来，只会在某天有人发现少了一条消息。
///
/// 三种情况都返回 `None`，都表示「这个分区没有要删的」：
/// - 分区里所有消息都晚于 `before`（反查落到低位点）；
/// - 反查结果带错误（权限受限、leader 迁移中）；
/// - 服务端给了 `Offset::End`/`Invalid` 这类无意义的位点。
pub fn seek_low_by_timestamp(
    worker: &BaseConsumer,
    topic: &str,
    partition: i32,
    before: i64,
) -> Option<i64> {
    let mut list = TopicPartitionList::new();
    list.add_partition_offset(topic, partition, Offset::Offset(before))
        .ok()?;

    let found = worker.offsets_for_times(list, SEEK_TIMEOUT).ok()?;
    let element = found.find_partition(topic, partition)?;
    if element.error().is_err() {
        return None;
    }
    positive(element.offset().to_raw())
}

/// 反查结果清洗：负值（含偏移过的 `Invalid`）统一当作「查不到」。
///
/// librdkafka 在没有匹配消息时会回 `-1`。把它当成位点用会算出
/// 「要删到 -1」，那不是任何一个分区上真实存在的边界。
fn positive(raw: Option<i64>) -> Option<i64> {
    raw.filter(|value| *value >= 0)
}

/// 提交删除记录。
///
/// `targets` 是 `(分区, 新低位点)`。服务端返回的位点表里每个分区都带自己的
/// 错误码，这里逐条读出来 —— 只看 `KafkaResult` 的外层结果会把
/// 「9 个成功 1 个失败」变成「全部成功」。
pub async fn delete_records(
    admin: &AdminClient<DefaultClientContext>,
    topic: &str,
    targets: &[(i32, i64)],
) -> AppResult<Vec<PartitionPurgeResult>> {
    let mut list = TopicPartitionList::new();
    for (partition, low) in targets {
        list.add_partition_offset(topic, *partition, Offset::Offset(*low))
            .map_err(|error| {
                AppError::Invalid(format!("分区 {partition} 的删除位点无效: {error}"))
            })?;
    }

    let result = admin
        .delete_records(
            &list,
            &rdkafka::admin::AdminOptions::new().operation_timeout(Some(ADMIN_TIMEOUT)),
        )
        .await
        .map_err(|error| AppError::Broker(format!("删除 {topic} 的记录失败: {error}")))?;

    Ok(targets
        .iter()
        .map(|(partition, _)| {
            let error = result
                .find_partition(topic, *partition)
                .and_then(|element| element.error().err().map(|error| error.to_string()));
            PartitionPurgeResult {
                partition: *partition,
                error,
            }
        })
        .collect())
}

/// 删消费组。
///
/// 返回 `Ok((已删除, 失败原因))` 而不是一个 `Result`：
/// 一批组里可能有几个是活跃的（服务端回 `NonEmptyGroup`），其余删掉了。
/// 那种情况下用户最需要知道的是「谁没删掉、为什么」，而不是一个统一错误。
pub async fn delete_groups(
    admin: &AdminClient<DefaultClientContext>,
    groups: &[String],
) -> AppResult<(Vec<String>, Vec<KeyValue>)> {
    let names: Vec<&str> = groups.iter().map(String::as_str).collect();
    let results = admin
        .delete_groups(
            &names,
            &rdkafka::admin::AdminOptions::new().operation_timeout(Some(ADMIN_TIMEOUT)),
        )
        .await
        .map_err(|error| AppError::Broker(format!("删除消费组失败: {error}")))?;

    let mut done = Vec::new();
    let mut failed = Vec::new();
    for result in results {
        match result {
            Ok(name) => done.push(name),
            Err((name, error)) => failed.push(KeyValue::new(
                name.clone(),
                explain_group_error(&name, error),
            )),
        }
    }
    Ok((done, failed))
}

/// 把删除消费组的错误翻译成下一步该做什么。
///
/// `NonEmptyGroup` 是最常见的一个：组里还有在线成员，服务端拒绝删除。
/// 界面直接显示 `NonEmptyGroup` 等于让用户去搜文档 —— 而正确动作很明确：
/// 先让消费者下线，再删。
fn explain_group_error(name: &str, error: rdkafka::types::RDKafkaErrorCode) -> String {
    use rdkafka::types::RDKafkaErrorCode as Code;
    match error {
        Code::NonEmptyGroup => format!(
            "组 {name} 还有在线成员，服务端拒绝删除；请先停掉这些消费者（或等它们下线）再重试"
        ),
        Code::GroupIdNotFound | Code::UnknownGroup => {
            format!("组 {name} 不存在，可能已经被别的操作删掉了")
        }
        Code::GroupAuthorizationFailed => {
            format!("当前账号没有删除组 {name} 的权限（需要 Delete 权限）")
        }
        other => format!("删除组 {name} 失败: {other}"),
    }
}

/// 把部分成功的结果拼成一句能直接展示的话。
///
/// 三条信息缺一不可：删了多少、哪些分区没删掉、为什么 —— 只说「部分失败」
/// 等于让用户自己去猜哪些分区还是脏的。
pub fn summarize(plan: &PurgePlan, results: &[PartitionPurgeResult]) -> PurgeOutcome {
    let done: Vec<i32> = results
        .iter()
        .filter(|item| item.error.is_none())
        .map(|item| item.partition)
        .collect();
    let failed: Vec<KeyValue> = results
        .iter()
        .filter_map(|item| {
            item.error
                .as_ref()
                .map(|reason| KeyValue::new(format!("分区 {}", item.partition), reason.clone()))
        })
        .collect();

    // 删掉的条数只按真正提交的分区算：失败的分区一条都没少，
    // 把它们算进去，「已删除 12 万条」就是一个假数字。
    let removed: i64 = plan
        .partitions
        .iter()
        .filter(|item| done.contains(&item.partition))
        .map(|item| item.removed())
        .sum();

    let detail = if failed.is_empty() {
        format!(
            "{} 的 {} 个分区已处理，共删除 {removed} 条消息",
            plan.topic,
            done.len()
        )
    } else if done.is_empty() {
        format!(
            "{} 的 {} 个分区全部失败，没有消息被删除",
            plan.topic,
            results.len()
        )
    } else {
        format!(
            "{} 的 {}/{} 个分区已处理（删除 {removed} 条），{} 个分区失败；失败的分区没有被动过",
            plan.topic,
            done.len(),
            results.len(),
            failed.len()
        )
    };

    PurgeOutcome {
        topic: plan.topic.clone(),
        partitions: done,
        removed,
        detail,
        failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{PurgeKind, PurgePartitionPlan};

    fn plan() -> PurgePlan {
        PurgePlan {
            topic: "orders".to_owned(),
            kind: PurgeKind::Truncate,
            partitions: vec![
                PurgePartitionPlan {
                    partition: 0,
                    current_low: 0,
                    current_high: 100,
                    target_low: 100,
                },
                PurgePartitionPlan {
                    partition: 1,
                    current_low: 0,
                    current_high: 50,
                    target_low: 50,
                },
            ],
            removed: 150,
            unresolved: Vec::new(),
            blocked: None,
            notes: Vec::new(),
        }
    }

    #[test]
    fn all_success_reports_total() {
        let results = vec![
            PartitionPurgeResult {
                partition: 0,
                error: None,
            },
            PartitionPurgeResult {
                partition: 1,
                error: None,
            },
        ];
        let outcome = summarize(&plan(), &results);
        assert_eq!(outcome.removed, 150);
        assert!(outcome.failed.is_empty());
        assert!(outcome.detail.contains("150"));
    }

    #[test]
    fn failed_partition_is_not_counted_as_removed() {
        let results = vec![
            PartitionPurgeResult {
                partition: 0,
                error: None,
            },
            PartitionPurgeResult {
                partition: 1,
                error: Some("leader 正在迁移".to_owned()),
            },
        ];
        let outcome = summarize(&plan(), &results);
        // 分区 1 的 50 条没删掉，报 150 会让用户以为干净了。
        assert_eq!(outcome.removed, 100);
        assert_eq!(outcome.partitions, vec![0]);
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.detail.contains("失败"));
    }

    #[test]
    fn all_failed_says_nothing_was_deleted() {
        let results = vec![PartitionPurgeResult {
            partition: 0,
            error: Some("权限不足".to_owned()),
        }];
        let outcome = summarize(&plan(), &results);
        assert_eq!(outcome.removed, 0);
        assert!(outcome.detail.contains("全部失败"));
    }

    #[test]
    fn invalid_offsets_from_seek_are_treated_as_missing() {
        assert_eq!(positive(Some(-1)), None);
        assert_eq!(positive(None), None);
        assert_eq!(positive(Some(0)), Some(0));
        assert_eq!(positive(Some(42)), Some(42));
    }

    #[test]
    fn non_empty_group_error_tells_user_to_stop_consumers() {
        use rdkafka::types::RDKafkaErrorCode as Code;
        let text = explain_group_error("orders-worker", Code::NonEmptyGroup);
        assert!(text.contains("在线成员"), "{text}");
        assert!(text.contains("orders-worker"), "{text}");
    }

    #[test]
    fn missing_group_error_is_not_reported_as_failure_noise() {
        use rdkafka::types::RDKafkaErrorCode as Code;
        let text = explain_group_error("orders-worker", Code::GroupIdNotFound);
        assert!(text.contains("不存在"), "{text}");
    }
}
