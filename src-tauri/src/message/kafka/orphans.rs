//! Kafka 无消费组主题：找出「有消息堆积、但没有任何消费组在消费」的分区。
//!
//! 排查常见故障时最想知道的一件事是「谁在写、没人在读」。这里把三份数据拼起来：
//! 主题元数据（有哪些分区）、各分区水位（末尾位点）、全部消费组的提交位点（读到了哪）。
//! 没有被任何消费组提交过位点的分区，就是没人消费的分区。
//!
//! 组装逻辑是纯函数，可以脱离 broker 单测；网络调用留在 `query` 里。

use std::sync::Arc;
use std::time::Duration;

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;
use rdkafka::{ClientConfig, TopicPartitionList};

use crate::broker::kafka::KafkaClient;
use crate::domain::{OrphanPartition, OrphanScanScope, OrphanTopic, OrphanTopicPage};
use crate::error::{AppError, AppResult};

/// 元数据与水位查询的超时。
const TIMEOUT: Timeout = Timeout::After(Duration::from_secs(10));

/// 一个分区的原始事实：末尾位点 + 是否被某个消费组提交过位点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionFact {
    pub partition: i32,
    pub high: i64,
    /// 是否已有消费组提交过该分区的位点。已提交即视为「有人在消费」。
    pub consumed: bool,
}

/// 由分区事实推出某个主题的堆积情况。
///
/// 只统计既没有消费组认领、又确实有消息的分区：空分区没有排查价值。
/// 返回 `None` 表示这个主题不构成问题，前端列表里不出现。
pub fn evaluate(topic: &str, facts: &[PartitionFact]) -> Option<OrphanTopic> {
    let mut partitions: Vec<OrphanPartition> = facts
        .iter()
        .filter(|fact| !fact.consumed && fact.high > 0)
        .map(|fact| OrphanPartition {
            partition: fact.partition,
            high: fact.high,
        })
        .collect();

    if partitions.is_empty() {
        return None;
    }
    partitions.sort_by_key(|item| item.partition);

    Some(OrphanTopic {
        topic: topic.to_owned(),
        partitions: partitions.len(),
        // 未消费分区的末尾位点之和即为堆积量。
        messages: partitions.iter().map(|item| item.high).sum(),
        detail: partitions,
    })
}

/// 按堆积量倒序排列，堆积最多的排前面——排查时最先要看的就是它。
pub fn sort_by_pressure(items: &mut [OrphanTopic]) {
    items.sort_by(|a, b| {
        b.messages
            .cmp(&a.messages)
            .then_with(|| a.topic.cmp(&b.topic))
    });
}

/// 把原始事实列表聚合成按主题分组的堆积列表。
pub fn assemble(entries: Vec<(String, Vec<PartitionFact>)>) -> Vec<OrphanTopic> {
    let mut items: Vec<OrphanTopic> = entries
        .into_iter()
        .filter_map(|(topic, facts)| evaluate(&topic, &facts))
        .collect();
    sort_by_pressure(&mut items);
    items
}

/// 分页切片。主题数量通常不大，分页主要是为了接口形态与其它列表保持一致。
pub fn page(items: Vec<OrphanTopic>, limit: usize, offset: usize) -> OrphanTopicPage {
    let total = items.len();
    let start = offset.min(total);
    let end = start.saturating_add(limit).min(total);
    OrphanTopicPage {
        items: items[start..end].to_vec(),
        total,
        has_more: end < total,
        next_offset: (end < total).then_some(end),
        ..OrphanTopicPage::default()
    }
}

/// 从元数据里筛出可扫描的主题名：跳过内部主题，按范围过滤。
pub fn pick_topics(available: &[String], scope: &OrphanScanScope) -> Vec<String> {
    let candidates = available
        .iter()
        .map(String::as_str)
        .filter(|name| !is_internal(name));
    if scope.is_targeted() {
        return scope.select(candidates);
    }
    let mut all: Vec<String> = candidates.map(str::to_owned).collect();
    all.sort();
    all
}

/// 用户点名却查不到的主题。静默忽略会让「我明明选了它」变成一次无解的困惑。
pub fn missing_topics(available: &[String], scope: &OrphanScanScope) -> Vec<String> {
    scope
        .topics
        .iter()
        .filter(|name| !available.iter().any(|item| item == *name))
        .cloned()
        .collect()
}

/// 内部主题（`__consumer_offsets` 等）由 Kafka 自己维护，不该出现在排查列表里。
pub fn is_internal(topic: &str) -> bool {
    topic.starts_with("__")
}

/// 查询全部消费组已提交位点，返回「主题 + 分区」集合。
fn committed_partitions(
    worker: &BaseConsumer,
) -> AppResult<std::collections::HashSet<(String, i32)>> {
    let committed = worker
        .committed_offsets(TopicPartitionList::new(), TIMEOUT)
        .map_err(|error| AppError::Broker(format!("查询消费组位点失败: {error}")))?;

    let mut set = std::collections::HashSet::new();
    for element in committed.elements() {
        if element.offset().to_raw().is_some() {
            set.insert((element.topic().to_owned(), element.partition()));
        }
    }
    Ok(set)
}

/// 候选主题列表：只拉元数据，不碰水位，几十毫秒就能返回。
///
/// 「先看有哪些主题，再决定扫哪些」是全量扫描之外唯一可行的收敛方式：
/// 一次元数据请求的代价与主题数量无关，而逐分区问水位是 O(主题 × 分区)。
pub async fn candidates(client: &KafkaClient) -> AppResult<Vec<String>> {
    let config = client.consumer_config("mqtui-orphans");
    let worker = build(&config)?;

    tokio::task::spawn_blocking(move || {
        let metadata = worker
            .fetch_metadata(None, TIMEOUT)
            .map_err(AppError::from)?;
        let mut names: Vec<String> = metadata
            .topics()
            .iter()
            .map(|topic| topic.name().to_owned())
            .filter(|name| !is_internal(name))
            .collect();
        names.sort();
        Ok(names)
    })
    .await
    .map_err(|error| AppError::Internal(format!("主题列表查询失败: {error}")))?
}

/// 网络查询入口：拉元数据、按范围筛主题、逐分区问水位、汇总消费组位点。
pub async fn query(
    client: &KafkaClient,
    scope: OrphanScanScope,
    limit: Option<usize>,
    offset: Option<usize>,
) -> AppResult<OrphanTopicPage> {
    let config = client.consumer_config("mqtui-orphans");
    let worker = Arc::new(build(&config)?);

    let collected = tokio::task::spawn_blocking(move || collect(&worker, &scope))
        .await
        .map_err(|error| AppError::Internal(format!("无消费组主题查询失败: {error}")))??;

    Ok(OrphanTopicPage {
        scanned_topics: collected.entries.len(),
        missing_topics: collected.missing,
        ..page(
            assemble(collected.entries),
            clamp_limit(limit),
            offset.unwrap_or(0),
        )
    })
}

/// `collect` 的返回：扫描结果 + 用户点名却不存在的主题。
struct Collected {
    entries: Vec<(String, Vec<PartitionFact>)>,
    missing: Vec<String>,
}

/// 阻塞收集：元数据 → 按范围筛主题 → 水位 → 消费组位点。
///
/// 先取消费组位点再问水位：位点表是全集，水位是按主题问的，
/// 顺序反过来会让「筛主题」这一步无法提前收敛，白白多问一堆水位。
fn collect(worker: &BaseConsumer, scope: &OrphanScanScope) -> AppResult<Collected> {
    let metadata = worker
        .fetch_metadata(None, TIMEOUT)
        .map_err(AppError::from)?;
    let mut available: Vec<String> = metadata
        .topics()
        .iter()
        .map(|topic| topic.name().to_owned())
        .collect();
    available.sort();

    let targets = pick_topics(&available, scope);
    let missing = missing_topics(&available, scope);

    let mut collected = Collected {
        entries: Vec::with_capacity(targets.len()),
        missing,
    };
    if targets.is_empty() {
        return Ok(collected);
    }

    let consumed = committed_partitions(worker)?;

    for topic in metadata.topics() {
        if !targets.iter().any(|name| name == topic.name()) {
            continue;
        }

        let mut facts = Vec::with_capacity(topic.partitions().len());
        for partition in topic.partitions() {
            // 每个分区问一次水位是唯一可行的办法：Kafka 协议没有批量水位接口。
            let (_low, high) = worker
                .fetch_watermarks(topic.name(), partition.id(), TIMEOUT)
                .map_err(AppError::from)?;
            facts.push(PartitionFact {
                partition: partition.id(),
                high,
                consumed: consumed.contains(&(topic.name().to_owned(), partition.id())),
            });
        }
        collected.entries.push((topic.name().to_owned(), facts));
    }
    Ok(collected)
}

/// 单页上限，避免把上万个主题一次全量返回。
pub const DEFAULT_LIMIT: usize = 100;
pub const MAX_LIMIT: usize = 500;

pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn build(config: &ClientConfig) -> AppResult<BaseConsumer> {
    let consumer: BaseConsumer = config
        .create()
        .map_err(|error| AppError::Broker(format!("创建 Kafka 查询客户端失败: {error}")))?;
    Ok(consumer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(partition: i32, high: i64, consumed: bool) -> PartitionFact {
        PartitionFact {
            partition,
            high,
            consumed,
        }
    }

    #[test]
    fn consumed_partitions_are_ignored() {
        let topic = evaluate("orders", &[fact(0, 10, true), fact(1, 20, true)]);
        assert!(topic.is_none());
    }

    #[test]
    fn empty_partitions_are_ignored() {
        let topic = evaluate("orders", &[fact(0, 0, false)]);
        assert!(topic.is_none());
    }

    #[test]
    fn orphan_partitions_sum_high_watermarks() {
        let topic = evaluate(
            "orders",
            &[fact(0, 10, false), fact(1, 5, true), fact(2, 7, false)],
        )
        .expect("应判定为堆积");
        assert_eq!(topic.partitions, 2);
        assert_eq!(topic.messages, 17);
        assert_eq!(
            topic
                .detail
                .iter()
                .map(|item| item.partition)
                .collect::<Vec<_>>(),
            [0, 2]
        );
    }

    #[test]
    fn assemble_sorts_by_pressure() {
        let items = assemble(vec![
            ("small".to_owned(), vec![fact(0, 1, false)]),
            ("big".to_owned(), vec![fact(0, 100, false)]),
            ("clean".to_owned(), vec![fact(0, 50, true)]),
        ]);
        assert_eq!(
            items
                .iter()
                .map(|item| item.topic.as_str())
                .collect::<Vec<_>>(),
            ["big", "small"]
        );
    }

    #[test]
    fn page_slices_and_reports_more() {
        let items: Vec<OrphanTopic> = (0..3)
            .map(|index| evaluate(&format!("t{index}"), &[fact(0, 1, false)]).expect("非空"))
            .collect();

        let first = page(items.clone(), 2, 0);
        assert_eq!(first.items.len(), 2);
        assert!(first.has_more);
        assert_eq!(first.next_offset, Some(2));
        assert_eq!(first.total, 3);

        let second = page(items, 2, 2);
        assert_eq!(second.items.len(), 1);
        assert!(!second.has_more);
        assert_eq!(second.next_offset, None);
    }

    #[test]
    fn page_beyond_end_is_empty() {
        let result = page(Vec::new(), 10, 99);
        assert!(result.items.is_empty());
        assert!(!result.has_more);
    }

    #[test]
    fn limit_is_clamped() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(usize::MAX)), MAX_LIMIT);
    }
}
