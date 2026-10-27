//! Kafka 主题详情与主题运维（新建 / 扩容 / 删除）。
//!
//! 编排职责：把阻塞的元数据/水位查询与异步的管理操作拼在一起，
//! 并把「能不能做」的判断放在执行之前——`TopicSpec` / `PartitionExpansion` /
//! `TopicRemoval` 都是纯函数，界面与命令层共用同一套规则。

use std::sync::Arc;

use rdkafka::consumer::BaseConsumer;

use crate::broker::kafka::{KafkaClient, topics as admin};
use crate::domain::{
    BrokerKind, ConfigChange, ConfigCompatReport, ConfigOutcome, ConfigPlan, KeyValue,
    PartitionExpansion, PurgeKind, PurgeOutcome, PurgePlan, PurgeRequest, TopicCapabilities,
    TopicDetail, TopicOutcome, TopicRemoval, TopicSpec, config_compat_report,
    parse_cluster_version, plan_config_changes, plan_topic_purge,
};
use crate::error::{AppError, AppResult};

/// 面板查询用 consumer 的 group 前缀，与消息侧保持一致的命名习惯。
const GROUP_PREFIX: &str = "mqtui-topic";

/// 读取主题详情：分区布局 + 水位（阻塞线程）+ 非默认配置项（管理接口）。
///
/// 两步串行：配置项失败不该让整页报错，所以配置项的错误被吞掉，只留下空列表。
pub async fn detail(client: &KafkaClient, topic: &str) -> AppResult<TopicDetail> {
    if topic.trim().is_empty() {
        return Err(AppError::Invalid("主题名称不能为空".to_owned()));
    }

    let worker = Arc::new(build(client)?);
    let name = topic.to_owned();
    let mut detail = tokio::task::spawn_blocking(move || admin::fetch_layout(&worker, &name))
        .await
        .map_err(|error| AppError::Internal(format!("主题详情任务失败: {error}")))??;

    if !detail.internal {
        let admin_client = client.admin()?;
        if let Ok(configs) = admin::describe_configs(&admin_client, &detail.name).await {
            detail.configs = configs;
        }
    }

    Ok(detail)
}

/// 主题运维能力：由详情推导，界面据此启停按钮。
pub async fn capabilities(client: &KafkaClient, topic: &str) -> AppResult<TopicCapabilities> {
    let detail = detail(client, topic).await?;
    Ok(TopicCapabilities::for_topic(&detail))
}

/// 新建主题。
pub async fn create(client: &KafkaClient, spec: TopicSpec) -> AppResult<TopicOutcome> {
    spec.validate().map_err(AppError::Invalid)?;

    let admin_client = client.admin()?;
    let detail = admin::create(&admin_client, &spec).await?;
    Ok(admin::outcome(&spec.normalized_name(), detail))
}

/// 扩容分区。先读一次当前分区数，避免用户对着过期的界面填一个非法值。
pub async fn expand(
    client: &KafkaClient,
    expansion: PartitionExpansion,
) -> AppResult<TopicOutcome> {
    let current = detail(client, &expansion.topic).await?;
    if current.internal || current.name.starts_with("__") {
        return Err(AppError::Unsupported(format!(
            "内部主题 {} 的分区数由 Kafka 管理，不可扩容",
            current.name
        )));
    }
    expansion
        .validate(current.partition_count())
        .map_err(AppError::Invalid)?;

    let admin_client = client.admin()?;
    let detail = admin::expand(&admin_client, &expansion).await?;
    Ok(admin::outcome(&expansion.topic, detail))
}

/// 删除主题。
///
/// 删除前先确认主题存在并复核可删性：Kafka 的删除接口对不存在的主题
/// 也可能返回成功，而面板必须保证「点了删除，主题真的没了」。
pub async fn delete(
    client: &KafkaClient,
    topic: &str,
    internal: Option<bool>,
) -> AppResult<TopicOutcome> {
    let current = detail(client, topic).await?;
    let removal = TopicRemoval::evaluate(&current.name, internal.unwrap_or(current.internal));
    if let Some(reason) = removal.reason() {
        return Err(AppError::Unsupported(reason.to_owned()));
    }

    let admin_client = client.admin()?;
    let detail = admin::delete(&admin_client, &current.name).await?;
    Ok(admin::outcome(&current.name, detail))
}

/// 修改主题配置项。
///
/// 三步，顺序不能变：
/// 1. 读当前详情（分区布局用于判断内部主题，配置项用于「改前/改后」对比）；
/// 2. 用纯函数 `plan_config_changes` 校验并算出真正变化的项；
/// 3. 提交增量修改。
///
/// 第 2 步放在网络调用之前：非法值、只读项、内部主题都在本地拦下，
/// 不必浪费一次往返再吃一个服务端错误。空计划直接返回成功而不是报错 ——
/// 用户点了保存但什么都没改，这是个合法结果，只是不该真的发请求。
pub async fn update_configs(
    client: &KafkaClient,
    topic: &str,
    changes: Vec<ConfigChange>,
) -> AppResult<ConfigOutcome> {
    let current = detail(client, topic).await?;

    let plan = plan_config_changes(
        &current.name,
        current.internal,
        &flatten(&current),
        &changes,
    )
    .map_err(|block| AppError::Invalid(block.reason()))?;

    if plan.items.is_empty() {
        return Ok(ConfigOutcome {
            topic: plan.topic,
            applied: Vec::new(),
            detail: "配置没有变化，未提交修改".to_owned(),
        });
    }

    // 提交前再体检一次，而不是信任界面带过来的结论：版本表是随面板发布的，
    // 用户可能停在一个旧页面里点了保存。这一步只多读一次版本，代价可以忽略。
    let names: Vec<String> = plan.items.iter().map(|item| item.key.clone()).collect();
    let compat = compat_of(client, &names).await;
    if let Some(blocked) = compat.blocking().first() {
        let detail = compat
            .items
            .iter()
            .find(|item| item.name == **blocked)
            .map(|item| item.message.clone())
            .unwrap_or_default();
        return Err(AppError::Unsupported(detail));
    }

    let admin_client = client.admin()?;
    let detail = admin::alter_configs(&admin_client, &plan).await?;

    Ok(ConfigOutcome {
        topic: plan.topic,
        applied: plan.items.iter().map(|item| item.key.clone()).collect(),
        detail,
    })
}

/// 详情里的配置项转成纯函数需要的形状。
fn flatten(detail: &TopicDetail) -> Vec<(String, String)> {
    detail
        .configs
        .iter()
        .map(|item| (item.key.clone(), item.value.clone()))
        .collect()
}

/// 配置预览：修改计划 + 版本兼容性体检。
///
/// 两件事一起返回，因为它们在界面上属于同一个确认框：用户需要同时看到
/// 「改成什么、有什么后果」和「这个集群支不支持」。分成两次请求会出现
/// 「计划已刷新、体检还是上一次改动」的错配。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPreview {
    pub plan: ConfigPlan,
    pub compat: ConfigCompatReport,
}

/// 只读地算一次修改计划与版本体检，供界面在提交前展示。
///
/// 与 `update_configs` 共用同一个纯函数，因此预览和实际提交不可能不一致。
pub async fn preview_configs(
    client: &KafkaClient,
    topic: &str,
    changes: Vec<ConfigChange>,
) -> AppResult<ConfigPreview> {
    let current = detail(client, topic).await?;
    let plan = plan_config_changes(
        &current.name,
        current.internal,
        &flatten(&current),
        &changes,
    )
    .map_err(|block| AppError::Invalid(block.reason()))?;

    let names: Vec<String> = plan.items.iter().map(|item| item.key.clone()).collect();
    let compat = compat_of(client, &names).await;
    Ok(ConfigPreview { plan, compat })
}

/// 版本体检。集群版本读不到时按「未知」出报告：放行，但把话说清楚。
async fn compat_of(client: &KafkaClient, names: &[String]) -> ConfigCompatReport {
    let raw = client.version().await;
    let parsed = raw.as_deref().and_then(parse_cluster_version);
    config_compat_report(names, parsed, raw.as_deref())
}

/// 一次性的只读 consumer。`enable.auto.commit = false` 由 `consumer_config` 保证。
fn build(client: &KafkaClient) -> AppResult<BaseConsumer> {
    client.inspection_consumer(&format!("{GROUP_PREFIX}-{}", uuid::Uuid::new_v4()))
}

/// 主题运维只对 Kafka 开放。
pub fn unsupported() -> AppError {
    AppError::Unsupported(format!(
        "{} 不支持 Kafka 主题运维",
        BrokerKind::RabbitMq.display_name()
    ))
}

/// 该中间件是否支持主题运维。
pub fn supports(kind: BrokerKind) -> bool {
    kind == BrokerKind::Kafka
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_kafka_supports_topic_ops() {
        assert!(supports(BrokerKind::Kafka));
        assert!(!supports(BrokerKind::RabbitMq));
    }

    #[test]
    fn unsupported_error_mentions_broker() {
        let error = unsupported();
        assert!(error.to_string().contains("RabbitMQ"));
    }
}

/// 预览一次主题写操作：动哪些分区、会失去多少条消息、能不能提交。
///
/// 预览单独成命令，与提交共用领域层的 `plan_topic_purge`：两处各写一份
/// 校验，早晚会漂移成「预览说能删，提交被拒」或者更糟的反过来。
pub async fn preview_purge(client: &KafkaClient, request: PurgeRequest) -> AppResult<PurgePlan> {
    let detail = detail(client, &request.topic).await?;
    let worker = build(client)?;
    let now = now_millis();
    // 按时间删记录要逐分区反查边界；清空只用末尾位点，不必问。
    let boundaries = |partition: i32, before: i64| -> Option<i64> {
        if request.kind != PurgeKind::DeleteBefore {
            return None;
        }
        crate::broker::kafka::purge::seek_low_by_timestamp(
            &worker,
            &request.topic,
            partition,
            before,
        )
    };
    Ok(plan_topic_purge(&detail, &request, now, &boundaries))
}

/// 提交一次主题写操作。
///
/// 提交前重新取一次详情并重新算计划，而不是复用预览的结果：
/// 预览与提交之间可能隔着几十秒的确认框，期间分区正在接收新消息。
/// 「按预览那一刻算出来的条数去删」会多删掉这期间进来的消息。
pub async fn commit_purge(client: &KafkaClient, request: PurgeRequest) -> AppResult<PurgeOutcome> {
    let plan = preview_purge(client, request).await?;
    if let Some(reason) = &plan.blocked {
        return Err(AppError::Invalid(reason.clone()));
    }

    let targets: Vec<(i32, i64)> = plan
        .partitions
        .iter()
        .map(|item| (item.partition, item.target_low))
        .collect();
    let admin_client = client.admin()?;
    let results =
        crate::broker::kafka::purge::delete_records(&admin_client, &plan.topic, &targets).await?;
    Ok(crate::broker::kafka::purge::summarize(&plan, &results))
}

/// 删除消费组的返回。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRemovalOutcome {
    /// 真正被删掉的组。
    pub deleted: Vec<String>,
    /// 删不掉的组及原因。**不是**整体失败：一批里删掉一部分是常态。
    pub failed: Vec<KeyValue>,
    /// 一句话结论。
    pub detail: String,
}

/// 删除一个或多个消费组。
///
/// 组名先去空白、去重、排序：用户从列表里勾选时前端给的顺序不稳定，
/// 而结果回执要能一一对上。
pub async fn delete_consumer_groups(
    client: &KafkaClient,
    groups: Vec<String>,
) -> AppResult<GroupRemovalOutcome> {
    let mut names: Vec<String> = groups
        .into_iter()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err(AppError::Invalid("请先选择要删除的消费组".to_owned()));
    }

    let admin_client = client.admin()?;
    let (deleted, failed) =
        crate::broker::kafka::purge::delete_groups(&admin_client, &names).await?;
    let detail = if failed.is_empty() {
        format!("已删除 {} 个消费组", deleted.len())
    } else if deleted.is_empty() {
        format!("{} 个消费组都没能删除；原因见列表", failed.len())
    } else {
        format!(
            "已删除 {} 个，{} 个没删掉；没删掉的组里可能还有在线成员",
            deleted.len(),
            failed.len()
        )
    };

    Ok(GroupRemovalOutcome {
        deleted,
        failed,
        detail,
    })
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}
