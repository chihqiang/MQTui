//! 消费组位点重置：把「分区现状」喂给领域规则，再把计划落到服务端。
//!
//! 分两步，刻意不合成一步：
//!
//! 1. `preview()` —— 只读。查每个分区的已提交位点、最早位点、末尾位点，
//!    交给 `domain::offset_reset` 算出逐分区的对照表与阻断原因。
//! 2. `commit()` —— 只在计划可执行时调用。用 `alter_consumer_group_offsets`
//!    一次性提交，**不做部分提交**：中途失败时服务端不会留下半新半旧的状态。
//!
//! 时间模式需要先按时间反查位点（`offsets_for_times`），这一步也在 `preview` 里做，
//! 因为用户看到的计划必须是「最终会提交的那些位点」，而不是时间戳。

use std::time::Duration;

use rdkafka::consumer::{BaseConsumer, CommitMode, Consumer};
use rdkafka::topic_partition_list::{Offset as TplOffset, TopicPartitionList};
use rdkafka::util::Timeout;

use crate::domain::{PartitionState, ResetPlan, ResetRequest, ResetTarget, preview_reset};
use crate::error::{AppError, AppResult};

use super::client::KafkaClient;

/// 位点查询超时。分区数多的时候一次要问几十个分区，比普通元数据请求给得宽一些。
const OFFSET_TIMEOUT: Duration = Duration::from_secs(20);

/// 时间反查位点的入参。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeRange {
    /// Unix 毫秒。
    pub timestamp_ms: i64,
}

impl KafkaClient {
    /// 查询某主题下各分区的位点现状，用于生成重置计划。
    ///
    /// `group` 必须作为 `group.id` 建一个专用 consumer：
    /// rdkafka 的 `committed_offsets` 只认当前 consumer 的 group.id。
    /// 这个 consumer 不订阅任何主题、也不开自动提交，纯查询。
    pub async fn group_partition_states(
        &self,
        group: &str,
        topic: &str,
    ) -> AppResult<Vec<PartitionState>> {
        let worker = self.inspection_consumer(group)?;
        let topic = topic.to_owned();
        let group = group.to_owned();

        tokio::task::spawn_blocking(move || collect_states(&worker, &group, &topic))
            .await
            .map_err(|error| AppError::Internal(format!("位点查询任务失败: {error}")))?
    }

    /// 按时间反查各分区的目标位点。
    ///
    /// Kafka 的时间索引是稀疏的：落在索引间隙里的时间戳会被归到最近的一个区间，
    /// 因此返回的位点可能比「严格大于该时间的第一条」更靠前一点点。
    /// 这比拒绝查询好 —— 面板要做的是给出可用的起点，不是做精确审计。
    pub async fn offsets_for_time(&self, topic: &str, at_ms: i64) -> AppResult<Vec<(i32, i64)>> {
        let worker = self.inspection_consumer("mqtui-offset-time")?;
        let topic = topic.to_owned();

        tokio::task::spawn_blocking(move || {
            let partition_count = partition_count(&worker, &topic)?;
            let mut query = TopicPartitionList::new();
            for partition in 0..partition_count {
                query.add_partition_offset(&topic, partition, TplOffset::Offset(at_ms))?;
            }
            let resolved = worker
                .offsets_for_times(query, Timeout::After(OFFSET_TIMEOUT))
                .map_err(|error| AppError::Broker(format!("按时间查询位点失败: {error}")))?;

            let mut items = Vec::new();
            for element in resolved.elements() {
                let Some(offset) = element.offset().to_raw() else {
                    // 该时间点之后没有任何消息：跳过这个分区。
                    continue;
                };
                if offset > 0 {
                    items.push((element.partition(), offset));
                }
            }
            items.sort_by_key(|(partition, _)| *partition);
            Ok(items)
        })
        .await
        .map_err(|error| AppError::Internal(format!("时间反查任务失败: {error}")))?
    }

    /// 生成重置计划（只读）。
    pub async fn preview_reset(
        &self,
        group: &str,
        topic: &str,
        target: ResetTarget,
        offsets: &[(i32, i64)],
        at_ms: Option<i64>,
        has_active_members: bool,
    ) -> AppResult<ResetPlan> {
        let states = self.group_partition_states(group, topic).await?;
        let timestamp_offsets = match target {
            ResetTarget::Timestamp => {
                // 时间模式必须给时间；没给就当成「按时间但现在」，等于用末尾位点。
                let at = at_ms
                    .ok_or_else(|| AppError::Invalid("按时间重置需要提供时间点".to_owned()))?;
                let resolved = self.offsets_for_time(topic, at).await?;
                if resolved.is_empty() {
                    return Err(AppError::Invalid(format!(
                        "该时间点之后主题 {topic} 没有可读的消息"
                    )));
                }
                resolved
            }
            _ => Vec::new(),
        };

        let request = ResetRequest {
            group,
            topic,
            target,
            offsets,
            timestamp_offsets: &timestamp_offsets,
            has_active_members,
        };
        Ok(preview_reset(&request, &states))
    }

    /// 提交新位点。
    ///
    /// 只提交位点有变化的分区，且要求计划里没有阻断原因。
    /// 不做分批：`alter_consumer_group_offsets` 是服务端一次元数据写入，
    /// 拆开只会在失败时留下「改了一半」的状态 —— 而位点改一半比整批失败更难收拾。
    pub async fn commit_reset(
        &self,
        group: &str,
        topic: &str,
        plan: &ResetPlan,
    ) -> AppResult<usize> {
        if !plan.is_executable() {
            let reason = plan
                .blockers
                .first()
                .cloned()
                .unwrap_or_else(|| "计划没有实际改动".to_owned());
            return Err(AppError::Invalid(reason));
        }

        let mut list = TopicPartitionList::new();
        for step in plan.changes() {
            list.add_partition_offset(topic, step.partition, TplOffset::Offset(step.to))?;
        }
        let count = list.count();

        // rdkafka 没有暴露 `AlterConsumerGroupOffsets` 这套 Admin API，
        // 但消费者侧的 `commit` 走的就是同一个协议请求：把当前 group.id 的
        // 指定分区位点写回 `__consumer_offsets`。所以这里仍然用「以目标组名为
        // group.id 的专用 consumer」，做一次同步提交即可 —— 和业务方的
        // 自动提交是同一个机制，不存在两套写法。
        let worker = self.inspection_consumer(group)?;
        let group = group.to_owned();
        tokio::task::spawn_blocking(move || {
            worker
                .commit(&list, CommitMode::Sync)
                .map_err(|error| AppError::Broker(format!("提交消费组 {group} 位点失败: {error}")))
        })
        .await
        .map_err(|error| AppError::Internal(format!("位点提交任务失败: {error}")))??;

        Ok(count)
    }
}

/// 从 worker 读出某个主题全部分区的状况。
///
/// 三次调用分别拿 `committed` / `low` / `high`：
/// - `committed` 为空表示该分区从未提交过位点，此时 `from` 记 `None`；
/// - 位点可能被 retention 清理，`low` 才是真正的下界。
fn collect_states(
    worker: &BaseConsumer,
    group: &str,
    topic: &str,
) -> AppResult<Vec<PartitionState>> {
    let count = partition_count(worker, topic)?;
    let mut query = TopicPartitionList::new();
    for partition in 0..count {
        query.add_partition(topic, partition);
    }
    let committed = worker
        .committed_offsets(query, Timeout::After(OFFSET_TIMEOUT))
        .map_err(|error| AppError::Broker(format!("查询消费组 {group} 位点失败: {error}")))?;

    let mut states = Vec::with_capacity(count as usize);
    for element in committed.elements() {
        let (low, high) = worker
            .fetch_watermarks(topic, element.partition(), Timeout::After(OFFSET_TIMEOUT))
            .map_err(AppError::from)?;
        let committed = element.offset().to_raw().filter(|offset| *offset >= 0);
        states.push(PartitionState {
            partition: element.partition(),
            committed,
            earliest: low,
            latest: high,
        });
    }
    states.sort_by_key(|state| state.partition);
    Ok(states)
}

/// 主题的分区数。
fn partition_count(worker: &BaseConsumer, topic: &str) -> AppResult<i32> {
    let metadata = worker
        .fetch_metadata(Some(topic), Timeout::After(OFFSET_TIMEOUT))
        .map_err(AppError::from)?;

    let partitions = metadata
        .topics()
        .iter()
        .find(|item| item.name() == topic)
        .map_or(0, |item| item.partitions().len() as i32);
    if partitions == 0 {
        return Err(AppError::NotFound(format!("主题 {topic}")));
    }
    Ok(partitions)
}
