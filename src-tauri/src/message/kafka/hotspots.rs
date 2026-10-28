//! 主题分区热点扫描：按需读取指定主题的逐分区水位，汇总成「分布是否倾斜」。
//!
//! 为什么按需而不是进页面就扫：分区水位只能逐个分区去问，代价是
//! O(主题数 × 分区数)，一个几百主题、上千分区的集群首屏就会被拖死。
//! 所以这里只接受明确的主题清单，由界面在用户点「分析」时给出。

use std::sync::Arc;
use std::time::Duration;

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;

use crate::broker::kafka::KafkaClient;
use crate::domain::{
    PartitionLoad, PartitionSpread, pick_hotspots, summarize_partitions as summarize,
};
use crate::error::{AppError, AppResult};

/// 单个分区的水位查询超时。分区间串行，给短一点，让超时尽快暴露。
const TIMEOUT: Timeout = Timeout::After(Duration::from_secs(5));

/// 一次最多分析多少个主题。再多就该缩小范围了，否则用户等的是几十秒白屏。
pub const MAX_TOPICS: usize = 50;

/// 扫描结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotspotReport {
    /// 全部分析过的主题（含健康主题，按主题名排序）。
    pub topics: Vec<PartitionSpread>,
    /// 仅热点主题，按偏离均分的程度倒序。界面默认只看这个。
    pub hotspots: Vec<PartitionSpread>,
    /// 用户点名却不存在的主题。静默跳过会让「我明明选了它」变成无解的困惑。
    pub missing: Vec<String>,
}

/// 分析指定主题的分区分布。
///
/// 传入空列表即拒绝，不做「不传就全扫」的兜底：那正是这一层要避免的失控。
pub async fn analyze(client: &KafkaClient, topics: Vec<String>) -> AppResult<HotspotReport> {
    let names = normalize_topics(topics)?;
    let config = client.consumer_config(&format!("mqtui-hotspot-{}", uuid::Uuid::new_v4()));
    let worker: Arc<BaseConsumer> = Arc::new(
        config
            .create()
            .map_err(|error| AppError::Broker(format!("创建 Kafka 查询客户端失败: {error}")))?,
    );

    let collected = tokio::task::spawn_blocking(move || collect(&worker, &names))
        .await
        .map_err(|error| AppError::Internal(format!("分区热点分析失败: {error}")))??;

    let spreads: Vec<PartitionSpread> = collected
        .available
        .iter()
        .map(|(name, loads)| summarize(name, loads))
        .collect();

    Ok(HotspotReport {
        hotspots: pick_hotspots(&spreads),
        topics: spreads,
        missing: collected.missing,
    })
}

/// 清洗并校验主题清单：去空白、去重、排序，然后在发请求之前拦下非法规模。
///
/// 校验放在网络调用之前，是为了让「全量扫描」这个失控入口根本走不进来。
pub fn normalize_topics(topics: Vec<String>) -> AppResult<Vec<String>> {
    let mut names: Vec<String> = topics
        .into_iter()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();

    if names.is_empty() {
        return Err(AppError::Invalid(
            "请先选择要分析的主题：分区水位只能逐个查询，全量扫描代价过高".to_owned(),
        ));
    }
    if names.len() > MAX_TOPICS {
        return Err(AppError::Invalid(format!(
            "一次最多分析 {MAX_TOPICS} 个主题，当前 {} 个，请缩小范围",
            names.len()
        )));
    }
    Ok(names)
}

/// 收集结果：真实存在的主题及其分区消息量，以及点名却不存在的主题。
pub struct CollectedSpreads {
    pub available: Vec<(String, Vec<PartitionLoad>)>,
    pub missing: Vec<String>,
}

/// 阻塞读取：一次元数据请求拿到布局，再逐分区问水位。
///
/// 水位查询失败的分区记成「未知」而不是整页报错：权限受限的账号能看到元数据、
/// 读不到水位，此时其余分区的分布结论仍然成立，只是少了一批数据 ——
/// 但少掉的那几个必须点名，不能当成空分区参与统计。
fn collect(worker: &BaseConsumer, names: &[String]) -> AppResult<CollectedSpreads> {
    let metadata = worker
        .fetch_metadata(None, TIMEOUT)
        .map_err(AppError::from)?;

    let mut available = Vec::new();
    let mut missing = Vec::new();

    for name in names {
        let Some(topic) = metadata.topics().iter().find(|item| item.name() == name) else {
            missing.push(name.clone());
            continue;
        };
        let loads: Vec<PartitionLoad> = topic
            .partitions()
            .iter()
            .map(|partition| {
                // 读不到就是读不到：`(0, 0)` 会被算成「这个分区是空的」，
                // 而空分区正是这一屏要解释的现象之一 —— 拿失败冒充它等于编了个结论。
                match worker.fetch_watermarks(name, partition.id(), TIMEOUT) {
                    Ok((low, high)) => PartitionLoad::new(partition.id(), low, high),
                    Err(_) => PartitionLoad::unavailable(partition.id()),
                }
            })
            .collect();
        available.push((name.clone(), loads));
    }

    Ok(CollectedSpreads { available, missing })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_selection_is_rejected() {
        // 这一层的核心规则：没有主题就不该发起任何水位请求。
        assert!(normalize_topics(Vec::new()).is_err());
        // 全是空白等于没选。
        assert!(normalize_topics(vec!["  ".to_owned(), "".to_owned()]).is_err());
    }

    #[test]
    fn topics_are_trimmed_deduped_and_sorted() {
        let names = normalize_topics(vec![
            " orders ".to_owned(),
            "audit".to_owned(),
            "orders".to_owned(),
        ])
        .expect("应当通过");
        assert_eq!(names, ["audit", "orders"]);
    }

    #[test]
    fn upper_bound_is_inclusive() {
        let exact: Vec<String> = (0..MAX_TOPICS).map(|index| format!("t{index}")).collect();
        assert_eq!(
            normalize_topics(exact).expect("上限本身应当放行").len(),
            MAX_TOPICS
        );
        let over: Vec<String> = (0..=MAX_TOPICS).map(|index| format!("t{index}")).collect();
        assert!(normalize_topics(over).is_err());
    }
}
