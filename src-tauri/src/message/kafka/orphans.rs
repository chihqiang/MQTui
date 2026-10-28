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

/// 一个分区的原始事实：可读区间 + 是否被某个消费组提交过位点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionFact {
    pub partition: i32,
    /// 分区最早可读位点。位点小于它的消息已经被 retention 清掉了。
    pub low: i64,
    pub high: i64,
    /// 是否已有消费组提交过该分区的位点。已提交即视为「有人在消费」。
    pub consumed: bool,
}

impl PartitionFact {
    /// 这个分区现在真正读得到的消息条数。
    ///
    /// 不是 `high`。`high` 是「从这个分区出生到现在写进来过多少条」，
    /// 而 retention 把低位点推走了之后，`[low, high)` 之前的那些已经不在磁盘上、
    /// 也没人会再读到它们。拿 `high` 当堆积量，等于把三个月前就被清掉的消息
    /// 也算成「正在堆积」：一个从来没被消费、但 retention 已经跑过好几轮的主题，
    /// 会显示成十几万条积压，而实际只剩最近一小时的量。
    ///
    /// 位点是单调的，`low <= high` 恒成立；这里仍然夹一道，避免畸形元数据算出负数。
    pub fn backlog(&self) -> i64 {
        (self.high - self.low).max(0)
    }
}

/// 由分区事实推出某个主题的堆积情况。
///
/// 只统计既没有消费组认领、又确实有消息的分区：空分区没有排查价值。
/// 返回 `None` 表示这个主题不构成问题，前端列表里不出现。
pub fn evaluate(topic: &str, facts: &[PartitionFact]) -> Option<OrphanTopic> {
    let mut partitions: Vec<OrphanPartition> = facts
        .iter()
        .filter(|fact| !fact.consumed && fact.backlog() > 0)
        .map(|fact| OrphanPartition {
            partition: fact.partition,
            low: fact.low,
            high: fact.high,
            backlog: fact.backlog(),
        })
        .collect();

    if partitions.is_empty() {
        return None;
    }
    partitions.sort_by_key(|item| item.partition);

    Some(OrphanTopic {
        topic: topic.to_owned(),
        partitions: partitions.len(),
        // 堆积量是可读区间之和，不是末尾位点之和：见 `PartitionFact::backlog`。
        messages: partitions.iter().map(|item| item.backlog).sum(),
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

/// 把扫描结果拼成返回给前端的一页。
///
/// 分页只切 `items`，扫描元信息必须在这里补回去：`page()` 返回的是
/// `Default::default()` 的骨架，如果调用方用结构体更新语法写在前面，
/// 会被它整个覆盖 ——「扫了多少个主题」「哪些主题不存在」两条提示就此消失，
/// 而界面上看不出来，只觉得「怎么少了几个主题」无从解释。
pub fn page_of(
    items: Vec<OrphanTopic>,
    missing: Vec<String>,
    limit: usize,
    offset: usize,
) -> OrphanTopicPage {
    page_with_notes(items, missing, Vec::new(), limit, offset)
}

/// 同上，并把「这份结论靠什么支撑」一起带上。
pub fn page_with_notes(
    items: Vec<OrphanTopic>,
    missing: Vec<String>,
    notes: Vec<String>,
    limit: usize,
    offset: usize,
) -> OrphanTopicPage {
    let scanned_topics = items.len();
    let mut result = page(items, limit, offset);
    result.scanned_topics = scanned_topics;
    result.missing_topics = missing;
    result.notes = notes;
    result
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

/// 「有人在读这个分区」的证据来源。
///
/// 两件事必须分开，因为它们的可靠性完全不同：
///
/// - **全部消费组的提交位点**：这才是「谁在读」的答案。但它要靠
///   `committed_offsets(空表)` 列出全部已提交位点，而这一步只对当前 consumer
///   的 `group.id` 名下的位点有意义 —— 见 `assess` 的说明。
/// - **非空消费组名单**：退而求其次的旁证。一个组存在本身就说明有人连过、
///   并且 broker 认了它（否则它不会出现在组列表里）。
pub struct Consumption {
    /// 提交过位点的分区。
    committed: std::collections::HashSet<(String, i32)>,
    /// 提交位点这一步是否真的做成了。`false` 时 `committed` 是空集，
    /// 而空集**不能**读成「没人提交过」。
    pub offsets_read: bool,
    /// 至少有一个非空消费组。用来判断「一个位点都没读到」该怎么说。
    pub groups_active: bool,
}

impl Consumption {
    /// 这个分区有没有消费组在消费。
    ///
    /// 两种口径，按证据强弱选：
    /// - 位点表**读到了**：只认位点。有组活着不代表每个分区都有人在读，
    ///   拿「有组「当「每个分区都有人读」会让真正没人消费的分区藏起来。
    /// - 位点表**没读到**：退回「有组还活着」这个更弱的证据。宁可把有人在读的
    ///   分区漏报成不堆积，也不能反过来 —— 那会把这一屏变成一整片假警报。
    pub fn consumed(&self, topic: &str, partition: i32) -> bool {
        if self.offsets_read {
            self.committed.contains(&(topic.to_owned(), partition))
        } else {
            self.groups_active
        }
    }
}

/// 读消费证据：全部消费组的提交位点 + 组是否活跃。
///
/// ## 为什么位点这一步经常做不成
///
/// `committed_offsets` 看的是**当前 consumer 的 `group.id`**。这个扫描用的
/// consumer 的 `group.id` 是容器名（`mqtui-orphans`），一个真实集群上
/// 不可能有这个名字的组 —— 于是位点表恒为空、错误码还是 0。
/// 原来的代码把这份空表当成结论用：`consumed` 恒为 `false`，
/// **每个有消息的分区都被判成「没人消费」**，界面上看起来像集群全线停摆。
///
/// 这里不再假装：位点表拿到就是真的证据，拿不到就明说拿不到，
/// 退回「组是否活跃」这个更弱的口径，并把这件事写进结果的 `notes`。
fn consumption(worker: &BaseConsumer) -> Consumption {
    let offsets = worker
        .committed_offsets(TopicPartitionList::new(), TIMEOUT)
        .map(|list| {
            list.elements()
                .iter()
                .filter(|element| element.offset().to_raw().is_some())
                .map(|element| (element.topic().to_owned(), element.partition()))
                .collect::<std::collections::HashSet<(String, i32)>>()
        })
        .ok();

    let groups_active = worker
        .fetch_group_list(None, TIMEOUT)
        .map(|list| {
            list.groups()
                .iter()
                .any(|group| !group.members().is_empty())
        })
        .unwrap_or(false);

    Consumption {
        offsets_read: offsets.as_ref().is_some_and(|set| !set.is_empty()),
        committed: offsets.unwrap_or_default(),
        groups_active,
    }
}

/// 位点表读不到时，结论要降级成一句话。
///
/// 不说这句话的版本是：表格照常渲染、每个分区都写着「积压 N 条、无消费组」，
/// 而真相是这份扫描根本没能读到任何位点。
pub fn consumption_note(consumption: &Consumption) -> Option<String> {
    if consumption.offsets_read {
        return None;
    }
    Some(if consumption.groups_active {
        "这次扫描没能读到任何已提交位点（本面板的 consumer 用的是自己的 group.id，         看不到别的组名下的位点），只能按「集群里还有活跃消费组」判断谁在读：         有组在跑时，这里不会列出任何主题。要按分区精确判断，请到消费组页面逐个查看"
            .to_owned()
    } else {
        "这次扫描既没读到已提交位点，也没发现任何活跃消费组：         下面的「没有人消费」是一个偏保守的结论，请到消费组页面再确认一次"
            .to_owned()
    })
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

    Ok(page_with_notes(
        assemble(collected.entries),
        collected.missing,
        collected.notes,
        clamp_limit(limit),
        offset.unwrap_or(0),
    ))
}

/// `collect` 的返回：扫描结果 + 用户点名却不存在的主题。
struct Collected {
    entries: Vec<(String, Vec<PartitionFact>)>,
    missing: Vec<String>,
    notes: Vec<String>,
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
        notes: Vec::new(),
    };
    if targets.is_empty() {
        return Ok(collected);
    }

    let consumption = consumption(worker);
    collected.notes.extend(consumption_note(&consumption));

    for topic in metadata.topics() {
        if !targets.iter().any(|name| name == topic.name()) {
            continue;
        }

        let mut facts = Vec::with_capacity(topic.partitions().len());
        for partition in topic.partitions() {
            // 每个分区问一次水位是唯一可行的办法：Kafka 协议没有批量水位接口。
            // 低位点必须一起读回来：堆积量要减掉已经被 retention 清走的那一段。
            let (low, high) = worker
                .fetch_watermarks(topic.name(), partition.id(), TIMEOUT)
                .map_err(AppError::from)?;
            facts.push(PartitionFact {
                partition: partition.id(),
                low,
                high,
                consumed: consumption.consumed(topic.name(), partition.id()),
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

    /// 从 0 开始、没有任何 retention 清理过的分区。
    fn fact(partition: i32, high: i64, consumed: bool) -> PartitionFact {
        PartitionFact {
            partition,
            low: 0,
            high,
            consumed,
        }
    }

    /// 低位点已经被 retention 推走的分区。
    fn trimmed(partition: i32, low: i64, high: i64, consumed: bool) -> PartitionFact {
        PartitionFact {
            partition,
            low,
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
    fn backlog_excludes_messages_retention_already_removed() {
        // 回归：堆积量曾经等于末尾位点，于是「从未被消费、但 retention 跑过几轮」
        // 的主题会显示成「积压 100 万条」，而实际只读得到最近的 500 条。
        let topic = evaluate("orders", &[trimmed(0, 999_500, 1_000_000, false)])
            .expect("确实还有可读的堆积");
        assert_eq!(topic.messages, 500);
        assert_eq!(topic.detail[0].backlog, 500);
        assert_eq!(topic.detail[0].low, 999_500);
    }

    #[test]
    fn fully_expired_partition_is_not_a_backlog() {
        // 位点区间被 retention 清空（low == high）：没有可读消息，不该出现在列表里。
        let topic = evaluate("orders", &[trimmed(0, 42, 42, false)]);
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
    fn page_keeps_scan_metadata() {
        // 回归：`page()` 返回的是 Default 骨架，谁用结构体更新语法拼结果，
        // scannedTopics / missingTopics 就会被静默抹掉。
        let items: Vec<OrphanTopic> = (0..3)
            .map(|index| evaluate(&format!("t{index}"), &[fact(0, 1, false)]).expect("非空"))
            .collect();
        let page = page_of(items, vec!["gone".to_owned()], 2, 0);

        // 扫描数是「扫了几个主题」，不是「这一页有几条」。
        assert_eq!(page.scanned_topics, 3);
        assert_eq!(page.missing_topics, vec!["gone".to_owned()]);
        assert_eq!(page.items.len(), 2);
        assert!(page.has_more);
    }

    #[test]
    fn page_metadata_survives_empty_result() {
        let page = page_of(Vec::new(), Vec::new(), 10, 0);
        assert_eq!(page.scanned_topics, 0);
        assert!(page.missing_topics.is_empty());
        assert!(page.items.is_empty());
    }

    #[test]
    fn unreadable_offsets_do_not_mark_every_partition_orphan() {
        // 回归：位点表恒为空（扫描用的 consumer 用的是容器名当 group.id，
        // 读不到别的组名下的位点），旧代码把这份空集当结论 ——
        // 每个有消息的分区都被判成「没人消费」，整屏看起来像集群停摆。
        let consumption = Consumption {
            committed: std::collections::HashSet::new(),
            offsets_read: false,
            groups_active: true,
        };
        assert!(consumption.consumed("orders", 0));
        assert!(consumption_note(&consumption).is_some());
    }

    #[test]
    fn readable_offsets_still_judge_per_partition() {
        let mut committed = std::collections::HashSet::new();
        committed.insert(("orders".to_owned(), 1));
        let consumption = Consumption {
            committed,
            offsets_read: true,
            groups_active: true,
        };
        // 位点表可读时只认位点：有活跃组不代表每个分区都有人在读。
        assert!(consumption.consumed("orders", 1));
        assert!(!consumption.consumed("orders", 0));
        assert!(consumption_note(&consumption).is_none());
    }

    #[test]
    fn note_wording_follows_whether_any_group_is_alive() {
        let no_groups = Consumption {
            committed: std::collections::HashSet::new(),
            offsets_read: false,
            groups_active: false,
        };
        let text = consumption_note(&no_groups).expect("读不到位点必须说明");
        assert!(text.contains("没发现任何活跃消费组"));
        // 有组在跑时说「不会列出任何主题」，而不是说「集群没人在消费」。
        let with_groups = Consumption {
            committed: std::collections::HashSet::new(),
            offsets_read: false,
            groups_active: true,
        };
        let text = consumption_note(&with_groups).expect("读不到位点必须说明");
        assert!(text.contains("活跃消费组"));
    }

    #[test]
    fn limit_is_clamped() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(usize::MAX)), MAX_LIMIT);
    }
}
