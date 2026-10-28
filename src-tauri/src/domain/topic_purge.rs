//! 主题级写操作：清空分区、截断到某个时间点。
//!
//! 面板到这一步才算真的「能动手」：在此之前它只能看、能建删主题、能改配置，
//! 但「这个主题里全是测试脏数据，清了吧」这件事必须去命令行敲 `kafka-topics.sh`。
//!
//! 三个动作在 Kafka 里是不同层级的 API，语义差别很大，界面必须分开说：
//!
//! - **删记录（DeleteRecords）**：把分区的低位点往前推，消息其实还在磁盘上，
//!   只是读不到了，等 retention 自然清理。所以它「快、可逆性为零、省不下磁盘」；
//! - **截断到时间（DeleteRecordsByTimestamp）**：同上，但边界由时间戳决定；
//! - **清空主题（DeleteRecords + ListOffsets(latest)）**：每条消息的低位点推到末尾。
//!
//! 三者的共同点是不需要重新分配副本、不影响分区数、不会让生产者失败。
//! 所以这里不做「你确定吗」之外的准入限制 —— 真正的风险在「不可逆」，
//! 而不可逆是由确认框承担的，不是由这里拦的。
//!
//! 判读规则全在纯函数里，网络动作由 `broker` 层执行。

use serde::{Deserialize, Serialize};

use super::{KeyValue, TopicDetail};

/// 用户选的写操作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PurgeKind {
    /// 清空：全部分区的低位点推到当前末尾。
    Truncate,
    /// 删记录：只处理时间戳早于给定毫秒时间戳的消息。
    DeleteBefore,
}

/// 一次写操作的请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeRequest {
    pub topic: String,
    pub kind: PurgeKind,
    /// 按时间删记录时的截止时间戳（毫秒）。`Truncate` 忽略这个字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
    /// 只处理这些分区；空表示全部。界面按「全选 / 单选」给值。
    #[serde(default)]
    pub partitions: Vec<i32>,
}

/// 单个分区的处理计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgePartitionPlan {
    pub partition: i32,
    /// 当前可读的第一条位点（低位点）。
    pub current_low: i64,
    /// 当前末尾位点。
    pub current_high: i64,
    /// 计划推到的新低位点。等于 `current_low` 时这条分区会被跳过。
    pub target_low: i64,
}

impl PurgePartitionPlan {
    /// 这条分区会被删掉多少条消息。
    pub fn removed(&self) -> i64 {
        (self.target_low - self.current_low).max(0)
    }

    /// 位点没变化的分区不需要发请求。
    pub fn is_noop(&self) -> bool {
        self.target_low <= self.current_low
    }
}

/// 写操作计划：做什么、动哪些分区、会失去多少条消息。
///
/// `blocked` 非空表示这份计划不能提交，原因是那句人话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgePlan {
    pub topic: String,
    pub kind: PurgeKind,
    /// 会被处理的分区（已排除位点无变化的）。
    pub partitions: Vec<PurgePartitionPlan>,
    /// 全部会消失的消息条数。
    pub removed: i64,
    /// 因按时间删记录而找不到边界、被跳过的分区。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved: Vec<i32>,
    /// 不能提交的原因；`None` 表示可以提交。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
    /// 操作前必须让用户知道的事实。界面在确认框里逐条展示。
    pub notes: Vec<String>,
}

/// 早于这个时间的毫秒值一定不是「消息时间」。
///
/// Kafka 0.10 之前没有时间戳，老数据读回来是 `-1`；而 1970 / 2001 这类值
/// 只会来自「把秒当成毫秒」或「选错了年份」。这类值算出来的 `target_low` 是 0，
/// 小于 `current_low`，于是被 `is_noop()` 静静跳过，最后整份计划变成
/// 「没有符合条件、需要删除的消息」—— 用户会以为时间填错了，其实是他填对了、
/// 面板把它吃掉了。
const EARLIEST_PLAUSIBLE_MS: i64 = 946_684_800_000; // 2000-01-01T00:00:00Z

/// 时间戳的上限：`before` 不可能晚于「现在」太多。
///
/// 允许一点余量（一分钟）：用户拿着别处的日志时间去查，那台机器的时钟
/// 比本机快几十秒是常态。超出这个范围基本是把毫秒填成了秒，
/// 那会把整个主题清空 —— 这类事情必须在本地拦下。
const CLOCK_SKEW_MS: i64 = 60_000;

/// 按时间反查分区边界的结论。
///
/// 「没有要删的」和「查不到」必须分开：混成同一个 `None`，
/// 权限不足就会被当成「全部删完了」静默跳过分区 —— 摘要里还看不到它。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Boundary {
    /// 分区里早于该时间的消息从这条位点开始。
    At(i64),
    /// 分区里没有早于该时间的消息，不需要处理。
    Nothing,
    /// 查不到，附原因。这个分区不会被处理，必须进 `unresolved`。
    Unknown(String),
}

/// 校验并生成计划。
///
/// `now_ms` 由调用方给，便于单测；`low_of` 用于按时间反查分区边界。
pub fn plan(
    detail: &TopicDetail,
    request: &PurgeRequest,
    now_ms: i64,
    low_of: &dyn Fn(i32, i64) -> Boundary,
) -> PurgePlan {
    let mut notes = Vec::new();
    let topic = detail.name.clone();

    if detail.internal || topic.starts_with("__") {
        return blocked(
            &topic,
            request.kind,
            format!("{topic} 是 Kafka 内部主题，不可清空：消费组位点与事务状态都在里面"),
            notes,
        );
    }

    if request.kind == PurgeKind::DeleteBefore {
        match request.before {
            None => {
                return blocked(
                    &topic,
                    request.kind,
                    "按时间删记录必须先给出截止时间".to_owned(),
                    notes,
                );
            }
            Some(before) if before <= 0 => {
                return blocked(
                    &topic,
                    request.kind,
                    format!("截止时间 {before} 看起来是秒级时间戳，这里要的是毫秒"),
                    notes,
                );
            }
            Some(before) if before > now_ms + CLOCK_SKEW_MS => {
                return blocked(
                    &topic,
                    request.kind,
                    "截止时间在未来，这会把整个主题清空；请确认填的是毫秒时间戳".to_owned(),
                    notes,
                );
            }
            Some(before) if before < EARLIEST_PLAUSIBLE_MS => {
                return blocked(
                    &topic,
                    request.kind,
                    format!(
                        "截止时间 {before} 太早（早于 2000 年），几乎肯定是单位或年份填错了；\
                         这个值会让「要删到哪儿」算不出来，请填毫秒时间戳"
                    ),
                    notes,
                );
            }
            Some(_) => {}
        }
        notes.push(
            "只删除早于截止时间的消息；分区的低位点会被往前推，磁盘要等 retention 才回收"
                .to_owned(),
        );
    } else {
        notes
            .push("全部分区的可读消息会立刻消失；磁盘不会立刻释放，要等 retention 清理".to_owned());
    }

    // 选中分区：空表示全部。给了不存在的分区号要在本地拦下，
    // 否则服务端只对其中几个报错，用户看到的是一份「部分成功」的怪结果。
    let chosen: Vec<i32> = if request.partitions.is_empty() {
        detail
            .partitions
            .iter()
            .map(|item| item.partition)
            .collect()
    } else {
        let mut selected = request.partitions.clone();
        selected.sort_unstable();
        selected.dedup();
        let unknown: Vec<i32> = selected
            .iter()
            .copied()
            .filter(|partition| {
                !detail
                    .partitions
                    .iter()
                    .any(|item| item.partition == *partition)
            })
            .collect();
        if !unknown.is_empty() {
            return blocked(
                &topic,
                request.kind,
                format!(
                    "分区 {} 不存在于 {topic}，请刷新后重选",
                    unknown
                        .iter()
                        .map(i32::to_string)
                        .collect::<Vec<_>>()
                        .join("、")
                ),
                notes,
            );
        }
        selected
    };

    let mut planned = Vec::new();
    let mut unresolved = Vec::new();
    for item in detail
        .partitions
        .iter()
        .filter(|item| chosen.contains(&item.partition))
    {
        let target_low = match request.kind {
            PurgeKind::Truncate => item.high,
            PurgeKind::DeleteBefore => {
                let before = request.before.unwrap_or_default();
                match low_of(item.partition, before) {
                    // 分区里没有更早的消息：没有可删的，跳过而不是报错。
                    Boundary::Nothing => continue,
                    Boundary::Unknown(_) => {
                        unresolved.push(item.partition);
                        continue;
                    }
                    Boundary::At(low) if low < 0 => {
                        unresolved.push(item.partition);
                        continue;
                    }
                    Boundary::At(low) => low.min(item.high),
                }
            }
        };

        let entry = PurgePartitionPlan {
            partition: item.partition,
            current_low: item.low,
            current_high: item.high,
            target_low,
        };
        if !entry.is_noop() {
            planned.push(entry);
        }
    }

    if !unresolved.is_empty() {
        let list = unresolved
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join("、");
        notes.push(format!(
            "分区 {list} 的按时间边界查不到，已跳过；它们没有被动过"
        ));
    }

    if planned.is_empty() {
        let reason = if unresolved.is_empty() {
            "所选分区里没有符合条件、需要删除的消息".to_owned()
        } else {
            format!(
                "分区 {} 的按时间边界查不到（权限或 leader 迁移），无法确定要删到哪里；                 请确认账号有 DESCRIBE 权限后重试",
                unresolved
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join("、")
            )
        };
        return blocked(&topic, request.kind, reason, notes);
    }

    let removed: i64 = planned.iter().map(PurgePartitionPlan::removed).sum();
    PurgePlan {
        topic,
        kind: request.kind,
        partitions: planned,
        removed,
        unresolved,
        blocked: None,
        notes,
    }
}

fn blocked(topic: &str, kind: PurgeKind, reason: String, mut notes: Vec<String>) -> PurgePlan {
    if !notes.iter().any(|note| note.contains(&reason)) {
        notes.push(reason.clone());
    }
    PurgePlan {
        topic: topic.to_owned(),
        kind,
        partitions: Vec::new(),
        removed: 0,
        unresolved: Vec::new(),
        blocked: Some(reason),
        notes,
    }
}

/// 提交后的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeOutcome {
    pub topic: String,
    /// 真正提交了删除动作的分区。
    pub partitions: Vec<i32>,
    pub removed: i64,
    /// 一句话说明，直接展示。
    pub detail: String,
    /// 服务端对个别分区报的错：**部分成功**是常态（某个分区的 leader 正在迁移），
    /// 整轮按失败处理会让人误会「什么都没做」。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<KeyValue>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::topic::TopicPartitionInfo;

    fn detail(name: &str, layout: &[(i32, i64, i64)]) -> TopicDetail {
        TopicDetail {
            name: name.to_owned(),
            partitions: layout
                .iter()
                .map(|(partition, low, high)| TopicPartitionInfo {
                    partition: *partition,
                    leader: Some(1),
                    replicas: vec![1],
                    in_sync_replicas: vec![1],
                    low: *low,
                    high: *high,
                })
                .collect(),
            configs: Vec::new(),
            internal: name.starts_with("__"),
        }
    }

    fn request(kind: PurgeKind) -> PurgeRequest {
        PurgeRequest {
            topic: "orders".to_owned(),
            kind,
            before: None,
            partitions: Vec::new(),
        }
    }

    const NOW: i64 = 1_700_000_000_000;

    #[test]
    fn truncate_pushes_low_to_high_on_every_partition() {
        let snapshot = detail("orders", &[(0, 10, 30), (1, 0, 5)]);
        let result = plan(&snapshot, &request(PurgeKind::Truncate), NOW, &|_, _| {
            Boundary::Nothing
        });
        assert!(result.blocked.is_none());
        assert_eq!(result.removed, 25);
        assert_eq!(result.partitions.len(), 2);
        assert_eq!(result.partitions[0].target_low, 30);
    }

    #[test]
    fn internal_topic_is_refused() {
        let snapshot = detail("__consumer_offsets", &[(0, 0, 10)]);
        let result = plan(&snapshot, &request(PurgeKind::Truncate), NOW, &|_, _| {
            Boundary::Nothing
        });
        // 内部标记与 `__` 前缀任一命中都要挡住。
        assert!(result.blocked.is_some());
        assert!(result.removed == 0);
    }

    #[test]
    fn already_empty_partitions_are_skipped_not_failed() {
        let snapshot = detail("orders", &[(0, 10, 10), (1, 0, 3)]);
        let result = plan(&snapshot, &request(PurgeKind::Truncate), NOW, &|_, _| {
            Boundary::Nothing
        });
        assert_eq!(result.partitions.len(), 1);
        assert_eq!(result.partitions[0].partition, 1);
        assert_eq!(result.removed, 3);
    }

    #[test]
    fn nothing_to_do_reports_reason_instead_of_empty_success() {
        let snapshot = detail("orders", &[(0, 10, 10)]);
        let result = plan(&snapshot, &request(PurgeKind::Truncate), NOW, &|_, _| {
            Boundary::Nothing
        });
        assert!(result.blocked.is_some());
        assert!(result.partitions.is_empty());
    }

    #[test]
    fn delete_before_requires_boundary_and_rejects_second_precision() {
        let snapshot = detail("orders", &[(0, 0, 100)]);
        let mut ask = request(PurgeKind::DeleteBefore);

        let missing = plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing);
        assert!(missing.blocked.expect("必须拒绝").contains("截止时间"));

        ask.before = Some(0);
        assert!(
            plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing)
                .blocked
                .expect("必须拒绝")
                .contains("毫秒")
        );
    }

    #[test]
    fn absurdly_early_boundary_is_rejected_instead_of_silently_noop() {
        // 1970 毫秒会算出 target_low = 0 < current_low，被当成「没有要删的」，
        // 整份计划变成「没有符合条件的消息」—— 用户会以为是自己的时间填错了。
        let snapshot = detail("orders", &[(0, 100, 200)]);
        let mut ask = request(PurgeKind::DeleteBefore);
        ask.before = Some(0);
        assert!(
            plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing)
                .blocked
                .expect("必须拒绝")
                .contains("毫秒")
        );

        ask.before = Some(931_000_000_000); // 1999 年
        assert!(
            plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing)
                .blocked
                .expect("必须拒绝")
                .contains("太早")
        );
    }

    #[test]
    fn boundary_in_the_future_is_rejected() {
        let snapshot = detail("orders", &[(0, 0, 100)]);
        let mut ask = request(PurgeKind::DeleteBefore);

        // 把秒当毫秒填：时间是过去，但算出来要删的边界会超过末尾。
        // 这里只拦「明显在未来」，所以先把秒级时间戳放大到毫秒级才触发。
        ask.before = Some(NOW + 3_600_000);
        let result = plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing);
        assert!(result.blocked.expect("必须拒绝").contains("未来"));

        // 一分钟内的偏差（本机与集群时钟不同步）应当放行。
        ask.before = Some(NOW - 1);
        assert!(
            plan(&snapshot, &ask, NOW, &|_, _| Boundary::At(50))
                .blocked
                .is_none()
        );
    }

    #[test]
    fn delete_before_skips_partitions_without_earlier_messages() {
        let snapshot = detail("orders", &[(0, 0, 100), (1, 20, 40)]);
        let mut ask = request(PurgeKind::DeleteBefore);
        ask.before = Some(NOW);
        // 分区 1 没有更早的消息（反查返回 None），只处理分区 0。
        let result = plan(&snapshot, &ask, NOW, &|partition, _| {
            if partition == 0 {
                Boundary::At(60)
            } else {
                Boundary::Nothing
            }
        });
        assert!(result.blocked.is_none());
        assert_eq!(result.partitions.len(), 1);
        assert_eq!(result.removed, 60);
    }

    #[test]
    fn unresolved_boundaries_are_listed_but_do_not_fail_the_rest() {
        let snapshot = detail("orders", &[(0, 0, 100), (1, 0, 100)]);
        let mut ask = request(PurgeKind::DeleteBefore);
        ask.before = Some(NOW);
        let result = plan(&snapshot, &ask, NOW, &|partition, _| {
            if partition == 0 {
                Boundary::At(50)
            } else {
                Boundary::Unknown("权限不足".to_owned())
            }
        });
        assert!(result.blocked.is_none());
        assert_eq!(result.unresolved, vec![1]);
        assert_eq!(result.removed, 50);
        assert!(result.notes.iter().any(|note| note.contains('1')));
    }

    #[test]
    fn unknown_partition_is_rejected_locally() {
        let snapshot = detail("orders", &[(0, 0, 10)]);
        let mut ask = request(PurgeKind::Truncate);
        ask.partitions = vec![0, 7];
        let result = plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing);
        let reason = result.blocked.expect("必须拒绝");
        assert!(reason.contains('7'), "{reason}");
    }

    #[test]
    fn selected_partitions_only() {
        let snapshot = detail("orders", &[(0, 0, 10), (1, 0, 10)]);
        let mut ask = request(PurgeKind::Truncate);
        ask.partitions = vec![1, 1];
        let result = plan(&snapshot, &ask, NOW, &|_, _| Boundary::Nothing);
        assert_eq!(result.partitions.len(), 1);
        assert_eq!(result.partitions[0].partition, 1);
    }

    #[test]
    fn target_beyond_high_is_clamped() {
        let snapshot = detail("orders", &[(0, 0, 100)]);
        let mut ask = request(PurgeKind::DeleteBefore);
        ask.before = Some(NOW);
        // 反查回来的位点比末尾还大（位点被截断、日志回退都可能出现），夹到 high。
        let result = plan(&snapshot, &ask, NOW, &|_, _| Boundary::At(500));
        assert_eq!(result.partitions[0].target_low, 100);
        assert_eq!(result.removed, 100);
    }
}
