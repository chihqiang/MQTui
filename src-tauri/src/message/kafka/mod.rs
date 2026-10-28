//! Kafka 消息实现：按分区分配 + offset 拉取，天然支持游标翻页。
//!
//! 面板只读不写：消费者使用随机的 group id 且从不提交 offset，
//! 避免把「看一眼」的行为写进业务消费组的位点。

pub mod acl;
pub mod consumer_groups;
pub mod dto;
pub mod group_block;
pub mod group_removal;
pub mod hotspots;
pub mod lag_trend;
pub mod locate;
pub mod locate_cursor;
pub mod migrations;
pub mod orphans;
pub mod quota;
pub mod resend;
pub mod throughput;
pub mod topics;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rdkafka::Message;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::error::KafkaError;
use rdkafka::util::Timeout;

use crate::broker::kafka::KafkaClient;
use crate::broker::kafka::client::DeliveryReceipt;
use crate::domain::{MessageDetail, MessageHeader, MessagePage, MessageQuery, MessageSummary};
use crate::error::{AppError, AppResult};

use self::dto::summary_from_message;

/// 单次拉取的最长等待时间。
const FETCH_TIMEOUT: Duration = Duration::from_millis(1500);
/// consumer group 前缀，只读消费者不会提交 offset。
const GROUP_PREFIX: &str = "mqtui-inspect";

/// 单分区单次最多读多少条，避免大分区把一页全占满、其他分区饿死。
const PER_PARTITION_BATCH: usize = 20;

/// 本次每个分区最多读多少条：按 limit 均摊，并受单分区上限约束。
fn per_partition_batch(limit: usize, partitions: usize) -> usize {
    if partitions == 0 {
        return 0;
    }
    limit.div_ceil(partitions).clamp(1, PER_PARTITION_BATCH)
}

// 游标记录每个分区下一页从哪个 offset 开始读。
// Kafka 的偏移是「每分区一条时间线」，单条 offset 无法表达多分区进度，
// 因此按分区保存下一条待读位置，形如 `订单@0:12,3:1024`：
// 位置以 `@` 与 topic 分隔，topic 本身允许包含 `@` 和 `:`。

/// 把分区进度编码成游标，分区按升序输出，保证同一进度只对应一个字符串。
fn encode_cursor(topic: &str, starts: &BTreeMap<i32, i64>) -> String {
    let body = starts
        .iter()
        .map(|(partition, offset)| format!("{partition}:{offset}"))
        .collect::<Vec<_>>()
        .join(",");
    format!("{topic}@{body}")
}

/// 解析游标。以最后一个 `@` 切分，因此 topic 内出现 `@` 也能正确还原。
fn parse_cursor(cursor: &str, topic: &str) -> AppResult<BTreeMap<i32, i64>> {
    let invalid = || AppError::Invalid(format!("非法的游标: {cursor}"));

    let Some((cursor_topic, body)) = cursor.rsplit_once('@') else {
        return Err(invalid());
    };
    if cursor_topic != topic {
        return Err(AppError::Invalid(format!(
            "游标属于主题 {cursor_topic}，与当前主题 {topic} 不匹配"
        )));
    }

    let mut starts = BTreeMap::new();
    for item in body.split(',').filter(|item| !item.is_empty()) {
        let (partition, offset) = item.split_once(':').ok_or_else(invalid)?;
        let partition = partition.parse::<i32>().map_err(|_| invalid())?;
        let offset = offset.parse::<i64>().map_err(|_| invalid())?;
        starts.insert(partition, offset);
    }
    Ok(starts)
}

/// 只看某个分区时，把「元数据里的分区总数」换算成这次要读的分区列表。
///
/// 越界必须报错而不是返回空列表：空列表在界面上与「这个分区没消息」长得一样，
/// 而实际原因是分区号过期了（例如扩容前从详情页带过来的 P8）。
fn partitions_to_read(total: usize, only: Option<i32>) -> AppResult<Vec<i32>> {
    match only {
        Some(partition) if partition < 0 || partition as usize >= total => Err(AppError::Invalid(
            format!("分区 {partition} 不存在：该主题只有 {total} 个分区"),
        )),
        Some(partition) => Ok(vec![partition]),
        None => Ok((0..total as i32).collect()),
    }
}

/// 在指定 topic 上拉取消息。
///
/// 分页语义是「从新到旧」：请求不带游标表示「加载最新」——丢掉历史位置，
/// 每个分区从末尾往前读一批；带游标表示「加载更多」，从游标处继续往前读。
pub async fn list(client: &KafkaClient, query: MessageQuery) -> AppResult<MessagePage> {
    let limit = super::clamp_limit(query.limit);
    let topic = query.target;

    // 带游标的“加载更多”从游标位置续读；不带游标则对齐“最近消息”。
    // 空串一并当成「没有游标」，免得前端把空值透传时被误判成非法游标。
    let resume = query
        .cursor
        .as_deref()
        .filter(|cursor| !cursor.is_empty())
        .map(|cursor| parse_cursor(cursor, &topic))
        .transpose()?;

    // 只看某个分区：它只影响「首次读取」时挑哪些分区，续读仍由游标说了算。
    let only_partition = query.partition;

    let config = client.consumer_config(&format!("{GROUP_PREFIX}-{}", uuid::Uuid::new_v4()));
    let consumer: BaseConsumer = config.create().map_err(AppError::from)?;
    let worker = Arc::new(consumer);

    let task_topic = topic.clone();
    let (items, starts, floors) = tokio::task::spawn_blocking(move || -> AppResult<_> {
        let partitions = worker
            .fetch_metadata(Some(&task_topic), Timeout::After(FETCH_TIMEOUT))
            .map_err(AppError::from)?
            .topics()
            .first()
            .map(|meta| meta.partitions().len())
            .unwrap_or(0);

        if partitions == 0 {
            return Err(AppError::NotFound(format!("主题 {task_topic}")));
        }
        let partitions = partitions_to_read(partitions, only_partition)?;

        // 每个分区的最早可读位点：既是首次读取的起点下界，也是判断
        // 「是不是已经翻到日志头」的依据（见 `build_page`）。
        let mut floors: BTreeMap<i32, i64> = BTreeMap::new();
        let mut starts = match resume {
            Some(starts) => starts,
            None => {
                // 首次读取：每个分区从末尾往前 batch 条开始，符合“看最近消息”的习惯。
                // 按分区均摊，避免 10 个分区时一次拉回 10 × limit 条。
                let batch = per_partition_batch(limit, partitions.len()) as i64;
                let mut starts = BTreeMap::new();
                for &partition in &partitions {
                    let (low, high) = watermarks(&worker, &task_topic, partition)?;
                    floors.insert(partition, low);
                    starts.insert(partition, (high - batch).max(low));
                }
                starts
            }
        };

        // 要读的分区可能远多于 limit（64 分区 / limit 20 很常见）。`plan` 每轮都要
        // 为**全部**分区查一次水位并 reassign —— 一次「加载更多」就是几十次水位请求。
        // 所以这里按住「每个分区至少还要读一条」，挑出前 `remaining` 个分区，
        // 其余留到下一轮：它们的进度都在游标里，不会丢。
        let mut active: Vec<i32> = partitions.clone();

        // 读满 limit 条，或者所有分区都追上水位为止。
        let mut collected = Vec::with_capacity(limit);
        while collected.len() < limit {
            let remaining = limit - collected.len();
            if active.len() > remaining {
                active.truncate(remaining);
            }
            let round: BTreeMap<i32, i64> = starts
                .iter()
                .filter(|(partition, _)| active.contains(partition))
                .map(|(partition, next)| (*partition, *next))
                .collect();
            let (assignments, scheduled, pending) = plan(&worker, &task_topic, &round)?;
            if pending == 0 {
                // 所有分区都读尽了（此时 collected 为空，否则上面已经退出循环）。
                break;
            }
            // 这一轮真正要读的分区。只有它们的位点该往前走 ——
            // 剩下的分区这一轮一条都没读，把它们也推走就等于把消息跳过去了。
            let mut scheduled = scheduled;
            worker.assign(&assignments).map_err(AppError::from)?;

            // 本轮读到了消息没有。一个分区读空就 `break` 会让别的分区再无机会：
            // 多分区主题下「最近消息」恰恰分布在各个分区的中段，队头那个分区读完
            // 就收工，等于只给了第一个分区的数据，而游标还写着其它分区的进度，
            // 「加载更多」拿到的是一份自相矛盾的结果。所以这里只在**一条都没读到**
            // （或时间预算耗尽）时才停，读到过消息就重新分配、接着读。
            let deadline = Instant::now() + FETCH_TIMEOUT;
            let mut progressed = false;
            while collected.len() < limit && Instant::now() < deadline {
                match worker.poll(FETCH_TIMEOUT) {
                    Some(Ok(message)) => {
                        progressed = true;
                        // poll 之后位点已经前进：无论本条是否收下，游标都要往后推，
                        // 否则“加载更多”会把同一条消息再取一遍。
                        //
                        // 只推本轮被分配到的分区：`active` 会按 `limit` 截断，
                        // 没被分配的分区这一轮读不到任何消息，把它们一起推走
                        // 就是静默跳过它们中间那一段（64 分区 / limit 20 时尤其明显）。
                        scheduled.remove(&message.partition());
                        starts.insert(message.partition(), message.offset() + 1);
                        collected.push(summary_from_message(&message));
                    }
                    // 分区读完是正常终止条件，不能当错误抛给前端。
                    Some(Err(KafkaError::PartitionEOF(_))) => break,
                    Some(Err(error)) => return Err(AppError::from(error)),
                    None => break,
                }
            }
            // 被分配却没读到任何消息的分区：游标往前推一条。
            skip_unread(&mut starts, &scheduled);

            if !progressed {
                // 本轮挑出来的分区要么读尽了、要么压根还没开始读：「没读到消息」
                // 不等于「读完了」，两件事的退出条件不同。
                // - 读尽的（游标退到低位点）移出候选，换下一批；
                // - 还有没读的是一个 `break`（第一次 assign 前的 `poll` 可能立刻回
                //   空队列），继续循环会是死循环 —— 与改动前的行为保持一致。
                let before = active.len();
                active.retain(|partition| {
                    starts
                        .get(partition)
                        .is_some_and(|next| floors.get(partition).is_none_or(|low| next > low))
                });
                if active.len() == before {
                    break;
                }
            }
        }

        // 列表从新到旧更符合排查习惯：同一页内按时间倒序。
        collected.sort_by_key(|item| std::cmp::Reverse(item.timestamp));

        Ok((collected, starts, floors))
    })
    .await
    .map_err(|error| AppError::Internal(format!("Kafka 拉取任务失败: {error}")))??;

    Ok(build_page(topic, items, starts, &floors))
}

/// 本轮被分配到、却一条都没读到的分区，游标往前推一格。
///
/// 为什么是「推一格」而不是「不动」：`plan` 把起点 clamp 到 `max(游标, low)`，
/// 而起点小于 `low` 的分区（这一段已经被 retention 清掉）在「还有没有得读」的
/// 判断里仍然算「有」—— 于是每一轮它都会被重新分配、`poll` 立刻回空。游标不动，
/// 它就永远占着 `active` 的名额，后面的分区一次也轮不到。
/// 推一格之后它要么读到东西，要么和 `low` 对齐，下一轮被 `floors` 判成读尽。
///
/// 代价是可能漏掉某个分区的一条消息。那是**读不到**的分区，本来也读不到；
/// 「页里少一条」比「一直加载不出来」诚实。
fn skip_unread(starts: &mut BTreeMap<i32, i64>, scheduled: &BTreeSet<i32>) {
    for partition in scheduled {
        if let Some(next) = starts.get_mut(partition) {
            *next += 1;
        }
    }
}

/// 查询单个分区的水位。
fn watermarks(worker: &BaseConsumer, topic: &str, partition: i32) -> AppResult<(i64, i64)> {
    worker
        .fetch_watermarks(topic, partition, Timeout::After(FETCH_TIMEOUT))
        .map_err(AppError::from)
}

/// 按游标位置生成分区分配；顺带统计还有多少分区没读尽。
///
/// 水位是「当时」的快照，但游标是持久的，两者取大可以同时兼顾
/// 新消息落盘与日志清理（retention）后被裁掉的旧位点。
///
/// 返回 `(分配表, 这一轮真正分配到的分区集合, 还有多少分区没读尽)`。
/// 分区集合是给调用方的关键信息：没被分配到的分区这一轮读不到任何消息，
/// 它们的游标就不该往前走（见 `list` 里对 `scheduled` 的处理）。
fn plan(
    worker: &BaseConsumer,
    topic: &str,
    starts: &BTreeMap<i32, i64>,
) -> AppResult<(rdkafka::TopicPartitionList, BTreeSet<i32>, usize)> {
    let mut assignments = rdkafka::TopicPartitionList::with_capacity(starts.len());
    let mut scheduled = BTreeSet::new();
    let mut pending = 0;

    for (&partition, &next) in starts {
        let (low, high) = watermarks(worker, topic, partition)?;
        let offset = next.max(low);
        if offset < high {
            pending += 1;
            scheduled.insert(partition);
            assignments
                .add_partition_offset(topic, partition, rdkafka::Offset::Offset(offset))
                .map_err(AppError::from)?;
        }
    }

    Ok((assignments, scheduled, pending))
}

/// 组装分页结果。
///
/// `has_more` 与 `cursor` 必须同进退：游标是「还能不能往下读」的唯一凭证，
/// 只给 has_more 不给 cursor 会让前端的「加载更多」点成空转。
///
/// 但「这一页有消息」不等于「还有更旧的」：一页刚好把日志读到底时，本来也会
/// 给出游标，于是「加载更多」拿到一个必然为空的下一页 —— 按钮亮着，点了什么都没有。
/// 所以这里按游标里的分区进度判断：所有分区都退到各自最早位点，才是真的读完了。
fn build_page(
    topic: String,
    items: Vec<MessageSummary>,
    starts: BTreeMap<i32, i64>,
    floors: &BTreeMap<i32, i64>,
) -> MessagePage {
    let exhausted = !starts.is_empty()
        && starts
            .iter()
            .all(|(partition, next)| floors.get(partition).is_some_and(|low| next <= low));
    let cursor = (!items.is_empty() && !exhausted)
        .then(|| encode_cursor(&topic, &starts))
        .filter(|cursor| !cursor.is_empty());
    let has_more = cursor.is_some();

    MessagePage {
        has_more,
        cursor,
        source: topic,
        items,
    }
}

/// 拉取单条消息详情。
///
/// 消息 ID 采用 `topic:partition:offset` 编码，可直接定位到具体 offset。
pub async fn detail(client: &KafkaClient, id: &str) -> AppResult<MessageDetail> {
    let (topic, partition, offset) = dto::parse_id(id)?;
    let message_id = id.to_owned();

    let config = client.consumer_config(&format!("{GROUP_PREFIX}-{}", uuid::Uuid::new_v4()));
    let consumer: BaseConsumer = config.create().map_err(AppError::from)?;
    let worker = Arc::new(consumer);

    tokio::task::spawn_blocking(move || -> AppResult<_> {
        let mut assignments = rdkafka::TopicPartitionList::with_capacity(1);
        assignments
            .add_partition_offset(&topic, partition, rdkafka::Offset::Offset(offset))
            .map_err(AppError::from)?;
        worker.assign(&assignments).map_err(AppError::from)?;

        match worker.poll(FETCH_TIMEOUT) {
            Some(Ok(message)) => Ok(dto::detail_from_message(&message)),
            Some(Err(error)) => Err(AppError::from(error)),
            None => Err(AppError::NotFound(message_id)),
        }
    })
    .await
    .map_err(|error| AppError::Internal(format!("Kafka 拉取任务失败: {error}")))?
}

/// 发送消息。
///
/// Kafka 侧只有三样东西：topic、key、payload。没有交换机、没有投递模式，
/// record headers 也和 AMQP 的 headers 不是一套东西 —— 所以签名里干脆不给这些参数，
/// 而不是收一个宽请求再从中挑几项用（那正是上一版「填了不生效」的来源）。
pub async fn send(
    client: &KafkaClient,
    topic: &str,
    key: Option<&str>,
    payload: &[u8],
    headers: &[MessageHeader],
) -> AppResult<DeliveryReceipt> {
    client.send(topic, key, payload, headers).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip() {
        let starts = BTreeMap::from([(0, 12), (3, 1024)]);
        let cursor = encode_cursor("orders", &starts);
        assert_eq!(cursor, "orders@0:12,3:1024");
        assert_eq!(parse_cursor(&cursor, "orders").expect("解析失败"), starts);
    }

    #[test]
    fn cursor_supports_topic_with_special_chars() {
        let cursor = encode_cursor("ns:orders@v2", &BTreeMap::from([(1, 5)]));
        assert_eq!(
            parse_cursor(&cursor, "ns:orders@v2").expect("解析失败"),
            BTreeMap::from([(1, 5)])
        );
    }

    #[test]
    fn cursor_rejects_topic_mismatch() {
        let cursor = encode_cursor("orders", &BTreeMap::from([(0, 1)]));
        assert!(parse_cursor(&cursor, "payments").is_err());
    }

    #[test]
    fn cursor_rejects_garbage() {
        assert!(parse_cursor("orders", "orders").is_err());
        assert!(parse_cursor("orders@x:1", "orders").is_err());
        assert!(parse_cursor("orders@0:1:2", "orders").is_err());
    }

    #[test]
    fn partition_filter_picks_only_that_partition() {
        assert_eq!(partitions_to_read(4, None).expect("全部"), vec![0, 1, 2, 3]);
        assert_eq!(partitions_to_read(4, Some(2)).expect("单个"), vec![2]);
    }

    #[test]
    fn partition_filter_rejects_out_of_range() {
        // 越界要报错：返回空列表会被读成「这个分区没有消息」。
        assert!(partitions_to_read(4, Some(4)).is_err());
        assert!(partitions_to_read(4, Some(-1)).is_err());
        // 只有一个分区时，P0 仍然合法。
        assert_eq!(partitions_to_read(1, Some(0)).expect("单个"), vec![0]);
    }

    #[test]
    fn per_partition_batch_is_fair_and_capped() {
        assert_eq!(per_partition_batch(100, 4), 20);
        assert_eq!(per_partition_batch(100, 1), 20);
        assert_eq!(per_partition_batch(3, 4), 1);
        assert_eq!(per_partition_batch(10, 0), 0);
    }

    #[test]
    fn only_the_scheduled_partitions_move_their_cursor() {
        // 回归：`active` 会按 `limit` 截断，没被分配到的分区一条都没读到。
        // 以前每轮都把所有 `active` 分区的水位设成「末尾往前一批」，
        // 「加载更多」时就重新算一遍 —— 于是 64 个分区 / limit 20 时，
        // 每次翻页都会把没读过的 44 个分区整体往前挪，中间那一段永远看不到。
        let mut starts = BTreeMap::from([(0, 10), (1, 10), (2, 10)]);
        let scheduled = BTreeSet::from([0]);
        skip_unread(&mut starts, &scheduled);
        // 只有被分配、且没读到的分区往前挪一格；其余原地不动。
        assert_eq!(starts.get(&0), Some(&11));
        assert_eq!(starts.get(&1), Some(&10));
        assert_eq!(starts.get(&2), Some(&10));
    }

    #[test]
    fn has_more_always_comes_with_cursor() {
        // 页里有消息就必须给出游标，否则前端「加载更多」点不动。
        let item = MessageSummary {
            id: "orders:0:7".to_owned(),
            key: None,
            topic: Some("orders".to_owned()),
            partition: Some(0),
            offset: Some(7),
            timestamp: None,
            preview: "hi".to_owned(),
            size: Some(2),
            payload: None,
        };
        // 0 号分区还剩 7 之前的消息（最早位点 1、游标 8），所以确实还能往下翻。
        let page = build_page(
            "orders".to_owned(),
            vec![item],
            BTreeMap::from([(0, 8)]),
            &BTreeMap::from([(0, 1)]),
        );
        assert_eq!(page.has_more, page.cursor.is_some());
        assert!(page.has_more);
    }

    #[test]
    fn empty_page_has_no_cursor() {
        let page = build_page(
            "orders".to_owned(),
            Vec::new(),
            BTreeMap::from([(0, 7)]),
            &BTreeMap::from([(0, 1)]),
        );
        assert!(!page.has_more);
        assert!(page.cursor.is_none());
    }

    #[test]
    fn page_at_log_head_reports_no_more() {
        // 回归：一页刚好把日志读到底时，曾经照样给出游标，
        // 于是「加载更多」永远亮着，点下去拿到一个必然为空的下一页。
        let item = MessageSummary {
            id: "orders:0:0".to_owned(),
            key: None,
            topic: Some("orders".to_owned()),
            partition: Some(0),
            offset: Some(0),
            timestamp: None,
            preview: "hi".to_owned(),
            size: Some(2),
            payload: None,
        };
        let page = build_page(
            "orders".to_owned(),
            vec![item],
            // 两个分区都退到了各自最早位点。
            BTreeMap::from([(0, 0), (1, 5)]),
            &BTreeMap::from([(0, 0), (1, 5)]),
        );
        assert!(!page.has_more, "已经翻到日志头，不该再给游标");
        assert!(page.cursor.is_none());
    }

    #[test]
    fn one_partition_left_keeps_paging() {
        // 只要还有一个分区没读完，就还能往下翻。
        let item = MessageSummary {
            id: "orders:0:0".to_owned(),
            key: None,
            topic: Some("orders".to_owned()),
            partition: Some(0),
            offset: Some(0),
            timestamp: None,
            preview: "hi".to_owned(),
            size: Some(2),
            payload: None,
        };
        let page = build_page(
            "orders".to_owned(),
            vec![item],
            BTreeMap::from([(0, 0), (1, 9)]),
            &BTreeMap::from([(0, 0), (1, 5)]),
        );
        assert!(page.has_more);
        assert_eq!(page.cursor.as_deref(), Some("orders@0:0,1:9"));
    }

    #[test]
    fn page_with_items_carries_cursor() {
        let item = MessageSummary {
            id: "orders:0:7".to_owned(),
            key: None,
            topic: Some("orders".to_owned()),
            partition: Some(0),
            offset: Some(7),
            timestamp: None,
            preview: "hi".to_owned(),
            size: Some(2),
            payload: None,
        };
        let page = build_page(
            "orders".to_owned(),
            vec![item],
            BTreeMap::from([(0, 8), (1, 3)]),
            &BTreeMap::from([(0, 1), (1, 1)]),
        );
        assert!(page.has_more);
        assert_eq!(page.cursor.as_deref(), Some("orders@0:8,1:3"));
    }
}
