//! Kafka 分区迁移（重分配）的读取侧：生成计划文本、校验计划、报告进度。
//!
//! 只读。写操作需要 `AlterPartitionReassignments`，这一版用的 librdkafka
//! 绑定里根本没有暴露它（连 `rd_kafka_AlterPartitionReassignments` 都没有），
//! 所以「一键执行」不是没做，是做不了——与其拼一个半残的裸 FFI，不如把
//! 能做好的那半做扎实：计划能生成、能校验、能把正在搬的分区标出来。
//!
//! 网络调用只有一处：读元数据拿「当前副本布局」。规则与组装全在
//! `domain::reassignment` 里，那边可脱库单测。

use std::sync::Arc;
use std::time::Duration;

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;

use crate::broker::kafka::KafkaClient;
use crate::domain::migration_runbook as runbook;
use crate::domain::reassignment::{
    Layout, MigrationReport, PlannedPartition, ReassignmentPlan, parse_plan, plan_lines, progress,
};
use crate::domain::{MigrationRunbook, ReassignPlanBlock, RunbookRequest, VerifySummary};
use crate::error::{AppError, AppResult};

/// 元数据请求超时。
const TIMEOUT: Timeout = Timeout::After(Duration::from_secs(10));

/// 一次最多处理多少个分区。再大的主题该用命令行分批做，面板画不下也验不完。
pub const MAX_PARTITIONS: usize = 2_000;

/// 计划校验结果：合法时带上解析后的计划，非法时给出原因与建议。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCheck {
    /// 计划是否可用。
    pub ok: bool,
    /// 校验通过时的计划。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<ReassignmentPlan>,
    /// 校验失败的原因（可直接展示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 集群里的 broker 列表，界面上直接列出来，用户不用猜 id。
    pub brokers: Vec<i32>,
    /// 主题当前是否存在。
    pub topic_exists: bool,
}

/// 校验一份计划文本。
///
/// 先看主题与 broker 是否存在，再交给纯函数做结构校验：
/// 这样「broker 9 不存在」这种提示来自真实集群，而不是一句通用的格式错误。
pub async fn check_plan(client: &KafkaClient, topic: &str, raw: &str) -> AppResult<PlanCheck> {
    let workers = Arc::new(build(client)?);
    let topic_name = topic.trim().to_owned();
    let snapshot = tokio::task::spawn_blocking(move || read_cluster(&workers, Some(&topic_name)))
        .await
        .map_err(|error| AppError::Internal(format!("读取集群元数据失败: {error}")))??;

    let topic_exists = snapshot.topic_exists;
    let result = parse_plan(raw, &snapshot.brokers, topic_exists);
    Ok(match result {
        Ok(plan) => PlanCheck {
            ok: true,
            plan: Some(plan),
            reason: None,
            brokers: snapshot.brokers,
            topic_exists,
        },
        Err(block) => PlanCheck {
            ok: false,
            plan: None,
            reason: Some(block.reason()),
            brokers: snapshot.brokers,
            topic_exists,
        },
    })
}

/// 为当前主题生成一份计划文本（原样导出当前布局）。
///
/// 这是重分配的起点，不是终点：用户拿它去改副本分布，改完再粘回来校验。
/// 面板自己不去「猜一个更均衡的布局」——那是 `kafka-reassign-partitions.sh
/// --generate` 的活，猜错了后果由用户的数据承担。
pub async fn export_plan(client: &KafkaClient, topic: &str) -> AppResult<String> {
    let current = current_layout(client, topic).await?;
    Ok(plan_lines(topic, &current, &[]))
}

/// 按目标计划报告迁移进度。
///
/// `raw` 是计划文本，重新校验一遍再读当前布局：
/// 界面上的计划文本可能已经被用户改过，进度必须基于「当前这份计划」。
pub async fn report_progress(
    client: &KafkaClient,
    topic: &str,
    raw: &str,
) -> AppResult<MigrationReport> {
    let workers = Arc::new(build(client)?);
    let topic_name = topic.trim().to_owned();
    let snapshot = tokio::task::spawn_blocking(move || read_cluster(&workers, Some(&topic_name)))
        .await
        .map_err(|error| AppError::Internal(format!("读取集群元数据失败: {error}")))??;

    let plan = parse_plan(raw, &snapshot.brokers, snapshot.topic_exists)
        .map_err(|block: ReassignPlanBlock| AppError::Invalid(block.reason()))?;
    if plan.partitions.len() > MAX_PARTITIONS {
        return Err(AppError::Invalid(format!(
            "计划里有 {} 个分区，超过一次处理上限 {MAX_PARTITIONS}",
            plan.partitions.len()
        )));
    }

    Ok(progress(&plan.topic, &plan.partitions, &snapshot.layout))
}

/// 生成一份分区迁移的执行方案。
///
/// 做的是「命令行那套流程里最容易出错的部分」：脚本参数拼装、前置条件检查、
/// `--verify` 输出解析。真正发起迁移仍然交给 `kafka-reassign-partitions.sh`，
/// 因为当前 rdkafka 绑定没有 `AlterPartitionReassignments` —— 见模块头的说明。
pub async fn runbook(
    client: &KafkaClient,
    topic: &str,
    raw: &str,
    throttle: Option<u64>,
    plan_file: Option<String>,
    min_insync: Option<u32>,
) -> AppResult<MigrationRunbook> {
    let current = current_layout(client, topic).await?;
    let workers = Arc::new(build(client)?);
    let topic_name = topic.trim().to_owned();
    let probe = topic_name.clone();
    let snapshot = tokio::task::spawn_blocking(move || read_cluster(&workers, Some(&probe)))
        .await
        .map_err(|error| AppError::Internal(format!("读取集群元数据失败: {error}")))??;

    let plan = parse_plan(raw, &snapshot.brokers, snapshot.topic_exists)
        .map_err(|block: ReassignPlanBlock| AppError::Invalid(block.reason()))?;

    let mut request = RunbookRequest::new(client.bootstrap(), &plan.topic);
    request.throttle = throttle.filter(|value| *value > 0);
    if let Some(file) = plan_file.filter(|name| !name.trim().is_empty()) {
        request.plan_file = file.trim().to_owned();
    }

    Ok(runbook::build(&request, &plan, &current, min_insync))
}

/// 解析 `--verify` 的原始输出。
///
/// 与进度报告同时返回一组「对不上」的说明：两份数据来源不同，
/// 一致性问题必须说出来，而不是让界面两处各显示一半。
pub async fn verify(
    client: &KafkaClient,
    topic: &str,
    raw_plan: &str,
    output: &str,
) -> AppResult<(VerifySummary, Vec<String>)> {
    let report = report_progress(client, topic, raw_plan).await?;
    let summary = runbook::parse_verify(output);
    let notes = runbook::reconcile(&report, &summary);
    Ok((summary, notes))
}

/// 当前主题的分区副本布局。
pub async fn current_layout(client: &KafkaClient, topic: &str) -> AppResult<Layout> {
    let workers = Arc::new(build(client)?);
    let topic_name = topic.trim().to_owned();
    let probe = topic_name.clone();
    let snapshot = tokio::task::spawn_blocking(move || read_cluster(&workers, Some(&probe)))
        .await
        .map_err(|error| AppError::Internal(format!("读取集群元数据失败: {error}")))??;

    if !snapshot.topic_exists && !topic_name.is_empty() {
        return Err(AppError::NotFound(format!("主题 {topic_name}")));
    }
    Ok(snapshot.layout)
}

/// 集群快照：broker 列表 + 主题当前布局。
struct ClusterSnapshot {
    brokers: Vec<i32>,
    layout: Layout,
    topic_exists: bool,
}

/// 一次元数据请求拿到全部需要的东西。
fn read_cluster(worker: &BaseConsumer, topic: Option<&str>) -> AppResult<ClusterSnapshot> {
    let metadata = worker
        .fetch_metadata(topic, TIMEOUT)
        .map_err(AppError::from)?;

    let mut brokers: Vec<i32> = metadata.brokers().iter().map(|item| item.id()).collect();
    brokers.sort_unstable();
    brokers.dedup();

    let mut layout = Vec::new();
    let mut topic_exists = false;
    for meta in metadata.topics() {
        if topic.is_some_and(|name| meta.name() != name) {
            continue;
        }
        topic_exists = true;
        for partition in meta.partitions() {
            layout.push(PlannedPartition {
                partition: partition.id(),
                replicas: partition.replicas().to_vec(),
            });
        }
    }
    layout.sort_by_key(|item| item.partition);

    Ok(ClusterSnapshot {
        brokers,
        layout,
        topic_exists,
    })
}

/// 一次性的只读 consumer。
fn build(client: &KafkaClient) -> AppResult<BaseConsumer> {
    client.inspection_consumer(&format!("mqtui-reassign-{}", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_and_parse_share_one_format() {
        // 导出的文本必须能被自己的校验器读回去，否则「导出 → 改 → 粘回」这条
        // 唯一的用法就断了。
        let layout: Layout = vec![
            PlannedPartition {
                partition: 0,
                replicas: vec![1, 2],
            },
            PlannedPartition {
                partition: 1,
                replicas: vec![2, 3],
            },
        ];
        let text = plan_lines("orders", &layout, &[1, 2, 3]);
        let plan = parse_plan(&text, &[1, 2, 3], true).expect("自己导出的计划必须能被自己解析");
        assert_eq!(plan.partitions, layout);
    }
}
