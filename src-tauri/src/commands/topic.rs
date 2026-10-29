//! Kafka 主题运维命令：详情、能力、新建、扩容、删除。
//!
//! 与消息命令同构：解析参数 → 取连接 → 交给 `message` 层 → 转换错误。
//! 能力查询单独成命令，是为了让界面在按钮渲染阶段就能拿到「能不能点」，
//! 而不是等用户点了再吃一个错误。

use tauri::State;

use crate::domain::{
    ConfigChange, ConfigOutcome, ConnectionId, MigrationReport, MigrationRunbook,
    PartitionExpansion, PurgeOutcome, PurgePlan, PurgeRequest, TopicCapabilities, TopicDetail,
    TopicOutcome, TopicSpec,
};
use crate::domain::{TopicThroughput, VerifySummary};
use crate::error::{AppError, AppResult};
use crate::message::kafka::hotspots::{self, HotspotReport};
use crate::message::kafka::migrations::{self, PlanCheck};
use crate::message::kafka::throughput;
use crate::message::kafka::topics::{self, ConfigPreview};
use crate::state::AppState;

use super::trace;

/// 读取主题详情：分区布局、副本同步情况、非默认配置项。
#[tauri::command]
pub async fn get_topic(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
) -> AppResult<TopicDetail> {
    let connection = state.connections.get(&id).await?;
    topics::detail(connection.as_kafka()?, &topic).await
}

/// 导出当前分区布局为一份重分配计划文本。
///
/// 这是重分配的起点：用户拿它去改副本分布，再粘回来校验与跟踪进度。
#[tauri::command]
pub async fn export_reassignment_plan(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
) -> AppResult<String> {
    crate::commands::trace::traced(
        "export_reassignment_plan",
        || format!("id={id}, topic={topic}"),
        async {
            let connection = state.connections.get(&id).await?;
            migrations::export_plan(connection.as_kafka()?, &topic).await
        },
    )
    .await
}

/// 校验一份重分配计划：结构、broker 是否存在、主题是否存在。
#[tauri::command]
pub async fn check_reassignment_plan(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    plan: String,
) -> AppResult<PlanCheck> {
    crate::commands::trace::traced(
        "check_reassignment_plan",
        || format!("id={id}, topic={topic}, plan={} 字节", plan.len()),
        async {
            let connection = state.connections.get(&id).await?;
            migrations::check_plan(connection.as_kafka()?, &topic, &plan).await
        },
    )
    .await
}

/// 按计划报告分区迁移进度。
#[tauri::command]
pub async fn get_migration_progress(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    plan: String,
) -> AppResult<MigrationReport> {
    let connection = state.connections.get(&id).await?;
    migrations::report_progress(connection.as_kafka()?, &topic, &plan).await
}

/// 生成分区迁移的执行方案：脚本 + 前置检查 + 收尾动作。
#[tauri::command]
pub async fn build_migration_runbook(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    plan: String,
    throttle: Option<u64>,
    plan_file: Option<String>,
    min_insync: Option<u32>,
) -> AppResult<MigrationRunbook> {
    let plan_file_desc = format!("{plan_file:?}");
    crate::commands::trace::traced(
        "build_migration_runbook",
        || {
            format!(
                "id={id}, topic={topic}, throttle={throttle:?}, minInsync={min_insync:?}, plan={} 字节, planFile={plan_file_desc}",
                plan.len()
            )
        },
        async {
            let connection = state.connections.get(&id).await?;
            migrations::runbook(
                connection.as_kafka()?,
                &topic,
                &plan,
                throttle,
                plan_file,
                min_insync,
            )
            .await
        },
    )
    .await
}

/// 解析 `kafka-reassign-partitions.sh --verify` 的输出，并与元数据进度对齐。
#[tauri::command]
pub async fn parse_migration_verify(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    plan: String,
    output: String,
) -> AppResult<VerifyResult> {
    let connection = state.connections.get(&id).await?;
    let (summary, notes) =
        migrations::verify(connection.as_kafka()?, &topic, &plan, &output).await?;
    Ok(VerifyResult { summary, notes })
}

/// `--verify` 的解析结果 + 与元数据的一致性说明。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub summary: VerifySummary,
    pub notes: Vec<String>,
}

/// 主题的运维能力：能不能删、能不能扩容，以及不能的原因。
#[tauri::command]
pub async fn get_topic_capabilities(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
) -> AppResult<TopicCapabilities> {
    let connection = state.connections.get(&id).await?;
    topics::capabilities(connection.as_kafka()?, &topic).await
}

/// 新建主题。
#[tauri::command]
pub async fn create_topic(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: TopicSpec,
) -> AppResult<TopicOutcome> {
    let spec_desc = trace::brief(&spec);
    crate::commands::trace::traced(
        "create_topic",
        || format!("id={id}, spec={spec_desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            topics::create(connection.as_kafka()?, spec).await
        },
    )
    .await
}

/// 扩容分区。Kafka 只支持增加，目标小于当前分区数会在本地被拒。
#[tauri::command]
pub async fn expand_topic(
    state: State<'_, AppState>,
    id: ConnectionId,
    expansion: PartitionExpansion,
) -> AppResult<TopicOutcome> {
    // 摘要先拼好：payload 闭包只借用，命令体要拿走所有权。
    let expansion_desc = trace::brief(&expansion);
    crate::commands::trace::traced(
        "expand_topic",
        || format!("id={id}, expansion={expansion_desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            topics::expand(connection.as_kafka()?, expansion).await
        },
    )
    .await
}

/// 删除主题。
///
/// `internal` 由前端从详情快照带回：删除前要复核「这真的是可以删的主题」，
/// 而不是信任前端传来的一个布尔值——它只用来交叉验证。
#[tauri::command]
pub async fn delete_topic(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    internal: Option<bool>,
) -> AppResult<TopicOutcome> {
    crate::commands::trace::traced(
        "delete_topic",
        || format!("id={id}, topic={topic}, internal={internal:?}"),
        async {
            if topic.trim().is_empty() {
                return Err(AppError::Invalid("主题名称不能为空".to_owned()));
            }
            let connection = state.connections.get(&id).await?;
            topics::delete(connection.as_kafka()?, &topic, internal).await
        },
    )
    .await
}

/// 预览配置项修改：会改成什么、有什么后果。
///
/// 单独成命令而不是让前端自己算，是为了让预览和提交共用后端同一个纯函数
/// `plan_config_changes`——两处各写一份校验，早晚会漂移成「预览说能改，提交被拒」。
#[tauri::command]
pub async fn preview_topic_configs(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    changes: Vec<ConfigChange>,
) -> AppResult<ConfigPreview> {
    let connection = state.connections.get(&id).await?;
    topics::preview_configs(connection.as_kafka()?, &topic, changes).await
}

/// 分析指定主题的分区分布，找出「少数分区扛住绝大部分流量」的主题。
///
/// 必须显式给出主题清单：分区水位只能逐分区查询，代价随「主题 × 分区」增长，
/// 全量扫描会让首屏卡住几十秒。要全量看，请走「无消费组」那一页。
#[tauri::command]
pub async fn analyze_partition_hotspots(
    state: State<'_, AppState>,
    id: ConnectionId,
    topics: Vec<String>,
) -> AppResult<HotspotReport> {
    let connection = state.connections.get(&id).await?;
    hotspots::analyze(connection.as_kafka()?, topics).await
}

/// 采样主题吞吐：读两次水位，相减除以秒数。
///
/// `window_ms` 由前端给（界面上是 3 / 5 / 10 / 30 秒这样的选项），
/// 缺省 5 秒，下限 1 秒、上限 1 分钟 —— 太短算出来是噪音，太长等于页面卡死。
/// 这个命令本身会阻塞 `window_ms` 那么久，属于设计如此：没有历史数据就不可能有速率。
#[tauri::command]
pub async fn sample_topic_throughput(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    window_ms: Option<u64>,
) -> AppResult<TopicThroughput> {
    let connection = state.connections.get(&id).await?;
    throughput::sample(connection.as_kafka()?, &topic, window_ms).await
}

/// 预览一次主题写操作：清空分区 / 按时间删记录。
///
/// 预览与提交共用后端同一个纯函数 `plan_topic_purge`，因此不可能出现
/// 「预览说能删、提交被拒」。界面拿这份计划去渲染确认框。
#[tauri::command]
pub async fn preview_topic_purge(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: PurgeRequest,
) -> AppResult<PurgePlan> {
    let connection = state.connections.get(&id).await?;
    topics::preview_purge(connection.as_kafka()?, request).await
}

/// 提交主题写操作。提交前重新算一遍计划，不复用预览的结果。
#[tauri::command]
pub async fn purge_topic(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: PurgeRequest,
) -> AppResult<PurgeOutcome> {
    let purge_desc = trace::brief(&request);
    crate::commands::trace::traced(
        "purge_topic",
        || format!("id={id}, request={purge_desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            topics::commit_purge(connection.as_kafka()?, request).await
        },
    )
    .await
}

/// 提交配置项修改。走增量接口，未列出的配置项保持原样。
#[tauri::command]
pub async fn update_topic_configs(
    state: State<'_, AppState>,
    id: ConnectionId,
    topic: String,
    changes: Vec<ConfigChange>,
) -> AppResult<ConfigOutcome> {
    let changes_desc = trace::brief(&changes);
    crate::commands::trace::traced(
        "update_topic_configs",
        || format!("id={id}, topic={topic}, changes={changes_desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            topics::update_configs(connection.as_kafka()?, &topic, changes).await
        },
    )
    .await
}
