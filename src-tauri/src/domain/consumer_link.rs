//! 队列到消费者的连线。
//!
//! 管理 API 里「谁在消费这个队列」散落在两个字段：队列自身的 `consumer_details`，
//! 以及全局 `/api/consumers` 的扁平列表。这里把它们整理成同一种形状，
//! 并把「消费者看起来活着、实际上不再收消息」这类判断收成纯函数。
//!
//! 全部不碰网络，便于脱网单测。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 队列的一个消费者（一个 AMQP channel 上的一条 `basic.consume`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueConsumer {
    /// 所属队列。
    pub queue: String,
    /// 服务端为该消费者分配的标签，`basic.consume` 的返回值。
    pub consumer_tag: String,
    /// 连接名，通常等同 hostname；排查时先看这个。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
    /// 发起消费的 channel，形如 `10.0.0.1:52312 -> 10.0.0.2:5672 (1)`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// 账号名。同一队列被多个服务消费时，靠它区分「是谁」。
    pub username: String,
    /// 是否手动 ack。`false` 意味着自动确认，消息投出去就没了。
    pub ack_required: bool,
    /// 预取条数；`0` 表示不限制，是一次投一大堆的常见原因。
    pub prefetch_count: u32,
    /// 该消费者上尚未确认的消息数，直接对应堆积量。
    pub messages_unacknowledged: u64,
}

/// 消费者健康状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsumerHealth {
    /// 有消费者、有预取上限或已确认过消息，看起来正常。
    Healthy,
    /// 手动 ack + 无预取上限 + 有未确认消息：一次把队列全推给它，别的消费者分不到。
    UnboundedPrefetch,
    /// 未确认消息数等于（或超过）预取上限：本地缓冲塞满，它已经不再收消息了。
    ///
    /// 这是「有消费者但队列还在涨」最常见的原因，从消费者数量上是看不出来的。
    PrefetchSaturated,
}

impl ConsumerHealth {
    /// 展示用说明。`Healthy` 无需提示，返回 `None`。
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Healthy => None,
            Self::UnboundedPrefetch => {
                Some("未设置预取上限，可能把整队列消息一次性拉到本地，其它消费者分不到")
            }
            Self::PrefetchSaturated => Some("未确认消息已达到预取上限，该消费者已不再接收新消息"),
        }
    }
}

/// 单个队列的消费端汇总。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueConsumption {
    pub queue: String,
    /// 队列中的待消费消息数。
    pub messages_ready: u64,
    /// 已投出但未确认的消息数。
    pub messages_unacknowledged: u64,
    pub consumers: Vec<QueueConsumer>,
    /// 该队列上异常消费者的数量，前端用它在队列列表里点红灯。
    pub unhealthy: usize,
}

impl QueueConsumption {
    /// 有堆积却一个消费者都没有：消息进来就再也不会出去。
    pub fn is_unconsumed(&self) -> bool {
        self.consumers.is_empty() && self.messages_ready > 0
    }
}

/// 判断单个消费者的健康状态。
///
/// 规则刻意保守：只在「看起来活着、实际不干活」时报警，
/// 不做「消费者少」「速率低」这类需要更多上下文的推断。
pub fn judge(consumer: &QueueConsumer) -> ConsumerHealth {
    if !consumer.ack_required {
        // 自动 ack 没有未确认堆积这回事，预取条数也不生效。
        return ConsumerHealth::Healthy;
    }
    if consumer.prefetch_count == 0 {
        return if consumer.messages_unacknowledged > 0 {
            ConsumerHealth::UnboundedPrefetch
        } else {
            ConsumerHealth::Healthy
        };
    }
    if consumer.messages_unacknowledged >= u64::from(consumer.prefetch_count) {
        ConsumerHealth::PrefetchSaturated
    } else {
        ConsumerHealth::Healthy
    }
}

/// 消费者行的去重键：`(队列, consumer tag)`。
///
/// 同一个 tag 在 `/api/consumers` 里出现两次，就是同一条 `basic.consume`，
/// 不是两个消费者。这不是假想的脏数据：`/api/queues` 与 `/api/consumers`
/// 是两个独立接口，面板这次读到的队列可能是「刚被告知 consumer 已取消」的那份，
/// 而消费者列表还是取消之前的，于是同一条消费有两个来源、两行同名记录。
type ConsumerKey = (String, String);

/// 合并同一个消费者标签的多条记录。
///
/// 现状数据里的计数按「行」算会整体虚高：未确认数被加了两次，
/// 健康判定也可能因此误报「预取已满」（5 + 5 = 10，刚好等于上限）。
/// 每行的数字本来都是该消费者自己的，重复行取最大值而不是求和。
fn merge_duplicate(kept: &mut QueueConsumer, other: &QueueConsumer) {
    kept.messages_unacknowledged = kept
        .messages_unacknowledged
        .max(other.messages_unacknowledged);
    kept.prefetch_count = kept.prefetch_count.max(other.prefetch_count);
    // 手动 ack 才是保守的答案：把「需要 ack」的消费者误判成自动 ack，
    // 会让本该报「预取已满」的那一行变绿。
    kept.ack_required |= other.ack_required;
    if kept.connection_name.is_none() {
        kept.connection_name = other.connection_name.clone();
    }
    if kept.channel.is_none() {
        kept.channel = other.channel.clone();
    }
    if kept.username.is_empty() {
        kept.username = other.username.clone();
    }
}

/// 把扁平消费者列表按队列分组。
///
/// `queues` 提供队列侧的堆积量，没有消费者的队列也要出现在结果里——
/// 「这个队列没人消费」本身就是结论，不能因为查不到消费者就省略。
pub fn group_by_queue(
    queues: &[(String, u64, u64)],
    consumers: &[QueueConsumer],
) -> Vec<QueueConsumption> {
    // 先按 (队列, tag) 去重，再分组：同一条消费被上报两次时，
    // 列表里会多出一行、未确认数翻倍、健康状态因此可能报错。
    let mut by_key: BTreeMap<ConsumerKey, QueueConsumer> = BTreeMap::new();
    for consumer in consumers {
        let key = (consumer.queue.clone(), consumer.consumer_tag.clone());
        match by_key.get_mut(&key) {
            Some(kept) => merge_duplicate(kept, consumer),
            None => {
                by_key.insert(key, consumer.clone());
            }
        }
    }
    let consumers: Vec<QueueConsumer> = by_key.into_values().collect();

    let mut result: Vec<QueueConsumption> = queues
        .iter()
        .map(|(name, ready, unacked)| QueueConsumption {
            queue: name.clone(),
            messages_ready: *ready,
            messages_unacknowledged: *unacked,
            consumers: consumers
                .iter()
                .filter(|consumer| &consumer.queue == name)
                .cloned()
                .collect(),
            unhealthy: 0,
        })
        .collect();

    for item in &mut result {
        item.unhealthy = item
            .consumers
            .iter()
            .filter(|consumer| judge(consumer) != ConsumerHealth::Healthy)
            .count();
    }

    for item in &mut result {
        // 同队列内按连接名排序，界面上多个消费者的顺序在刷新之间保持稳定。
        item.consumers.sort_by(|a, b| {
            a.connection_name
                .cmp(&b.connection_name)
                .then_with(|| a.consumer_tag.cmp(&b.consumer_tag))
        });
    }
    result.sort_by(|a, b| a.queue.cmp(&b.queue));
    result
}

/// 消费者连线的整体视图。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerLinks {
    pub queues: Vec<QueueConsumption>,
    /// 每个消费者带来的未确认消息总量，用于页面顶部的结论。
    pub unacknowledged_total: u64,
}

/// 生成连线视图。
pub fn summarize(queues: &[(String, u64, u64)], consumers: &[QueueConsumer]) -> ConsumerLinks {
    let grouped = group_by_queue(queues, consumers);
    let unacknowledged_total = grouped
        .iter()
        .flat_map(|item| item.consumers.iter())
        .map(|consumer| consumer.messages_unacknowledged)
        .sum();
    ConsumerLinks {
        queues: grouped,
        unacknowledged_total,
    }
}

/// 消费者的展示名：优先连接名，其次 consumer tag。
///
/// AMQP 的 consumer tag 常常是 `amq.ctag-xxxx`，人工排查时没有信息量。
impl QueueConsumer {
    pub fn display_name(&self) -> &str {
        self.connection_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.consumer_tag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consumer(tag: &str, prefetch: u32, unacked: u64, ack: bool) -> QueueConsumer {
        QueueConsumer {
            queue: "orders".to_owned(),
            consumer_tag: tag.to_owned(),
            connection_name: Some("svc-a".to_owned()),
            channel: None,
            username: "app".to_owned(),
            ack_required: ack,
            prefetch_count: prefetch,
            messages_unacknowledged: unacked,
        }
    }

    #[test]
    fn saturated_prefetch_is_flagged() {
        assert_eq!(
            judge(&consumer("t1", 10, 10, true)),
            ConsumerHealth::PrefetchSaturated
        );
        // 超过预取上限（老连接改小过配置）同样算满。
        assert_eq!(
            judge(&consumer("t1", 10, 12, true)),
            ConsumerHealth::PrefetchSaturated
        );
        assert_eq!(judge(&consumer("t1", 10, 9, true)), ConsumerHealth::Healthy);
    }

    #[test]
    fn unbounded_prefetch_with_pending_is_flagged() {
        assert_eq!(
            judge(&consumer("t1", 0, 3, true)),
            ConsumerHealth::UnboundedPrefetch
        );
        // 无上限但当前没积压，说明消费跟得上，不报警。
        assert_eq!(judge(&consumer("t1", 0, 0, true)), ConsumerHealth::Healthy);
    }

    #[test]
    fn auto_ack_consumers_never_flagged() {
        assert_eq!(judge(&consumer("t1", 0, 0, false)), ConsumerHealth::Healthy);
        assert_eq!(
            judge(&consumer("t1", 5, 99, false)),
            ConsumerHealth::Healthy
        );
    }

    #[test]
    fn queues_without_consumers_are_kept() {
        let queues = vec![("orders".to_owned(), 5, 0), ("audit".to_owned(), 2, 0)];
        let links = summarize(&queues, &[consumer("t1", 1, 0, true)]);
        assert_eq!(links.queues.len(), 2);
        let audit = links
            .queues
            .iter()
            .find(|item| item.queue == "audit")
            .expect("缺少队列");
        assert!(audit.consumers.is_empty());
        assert!(audit.is_unconsumed());
    }

    #[test]
    fn empty_queue_without_consumers_is_not_unconsumed() {
        let links = summarize(&[("audit".to_owned(), 0, 0)], &[]);
        assert!(!links.queues[0].is_unconsumed());
    }

    #[test]
    fn unhealthy_count_and_total_unacked() {
        let queues = vec![("orders".to_owned(), 10, 20)];
        let consumers = vec![consumer("t1", 10, 10, true), consumer("t2", 5, 1, true)];
        let links = summarize(&queues, &consumers);
        assert_eq!(links.queues[0].unhealthy, 1);
        assert_eq!(links.unacknowledged_total, 11);
    }

    #[test]
    fn consumers_are_sorted_stably() {
        let mut second = consumer("amq.ctag-b", 1, 0, true);
        second.connection_name = Some("svc-b".to_owned());
        let links = summarize(
            &[("orders".to_owned(), 0, 0)],
            &[second, consumer("amq.ctag-a", 1, 0, true)],
        );
        let names: Vec<&str> = links.queues[0]
            .consumers
            .iter()
            .map(|item| item.display_name())
            .collect();
        assert_eq!(names, ["svc-a", "svc-b"]);
    }

    #[test]
    fn duplicate_consumer_rows_are_merged_not_double_counted() {
        // 回归：同一个 tag 被上报两次时，未确认数被加了两次（5+5=10），
        // 正好等于预取上限 —— 一行本来正常的消费者被误报成「预取已满」。
        let mut second = consumer("t1", 10, 5, true);
        second.channel = Some("ch-1".to_owned());
        second.connection_name = None;

        let links = summarize(
            &[("orders".to_owned(), 10, 10)],
            &[consumer("t1", 10, 5, true), second],
        );

        assert_eq!(links.queues[0].consumers.len(), 1, "同一条消费不该出现两行");
        assert_eq!(links.queues[0].consumers[0].messages_unacknowledged, 5);
        assert_eq!(links.queues[0].unhealthy, 0, "5 < 10，不该报预取已满");
        // 缺失的字段从另一行补回来。
        assert_eq!(
            links.queues[0].consumers[0].channel.as_deref(),
            Some("ch-1")
        );
        // 顶部结论的合计同样不能被重复计算。
        assert_eq!(links.unacknowledged_total, 5);
    }

    #[test]
    fn duplicate_rows_keep_the_manual_ack_verdict() {
        // 一行说手动 ack、一行说自动 ack：取保守的那一侧，
        // 否则「预取已满」会被误判成健康。
        let mut auto = consumer("t1", 10, 10, false);
        auto.username = String::new();
        let links = summarize(
            &[("orders".to_owned(), 10, 10)],
            &[consumer("t1", 10, 10, true), auto],
        );
        let merged = &links.queues[0].consumers[0];
        assert!(merged.ack_required);
        assert_eq!(merged.username, "app");
        assert_eq!(links.queues[0].unhealthy, 1);
    }

    #[test]
    fn same_tag_on_different_queues_stays_separate() {
        // tag 只在所属连接 / 队列的语境里唯一，跨队列不能合并。
        let mut other = consumer("t1", 1, 0, true);
        other.queue = "audit".to_owned();
        let links = summarize(
            &[("orders".to_owned(), 0, 0), ("audit".to_owned(), 0, 0)],
            &[consumer("t1", 1, 0, true), other],
        );
        assert_eq!(links.queues[0].consumers.len(), 1);
        assert_eq!(links.queues[1].consumers.len(), 1);
    }

    #[test]
    fn display_name_falls_back_to_tag() {
        let mut item = consumer("amq.ctag-a", 1, 0, true);
        item.connection_name = Some(String::new());
        assert_eq!(item.display_name(), "amq.ctag-a");
        item.connection_name = None;
        assert_eq!(item.display_name(), "amq.ctag-a");
    }
}
