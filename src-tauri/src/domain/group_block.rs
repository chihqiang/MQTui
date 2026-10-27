//! 消费组的「队头阻塞」判读：组里有成员卡在某一条消息上，其余成员在空转。
//!
//! 这是 Kafka 消费最经典的一次事故，也是面板最容易看不出来的一次：
//! 看总滞后是「还有 12 万条」，看成员是「4 个成员都活着」，看分区是「有 3 个分区在动」。
//! 三个数字都正常，但消费速度是 0 —— 因为分区内是严格顺序的，
//! 一个分区被一条处理不完的消息顶住，挂在它上面的那个成员就再也不动了。
//!
//! 判据只有一条：**有成员被分配到的全部分区都停在原位**，而组里别的分区在前进。
//! 单个分区不动是正常的（本来就没消息）；整组不动也是正常的（没有流量）。
//! 只有「有人在动、有人一点不动」这种不均衡才是卡住。
//!
//! 这一层不碰网络，两次采样由调用方读好送进来。

use serde::{Deserialize, Serialize};

use super::consumer::{ConsumerGroupDetail, ConsumerGroupOffset};

/// 一个分区在采样窗口内的位移。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartitionShift {
    pub topic: String,
    pub partition: i32,
    /// 窗口起点已提交位点。
    pub from: Option<i64>,
    /// 窗口终点已提交位点。
    pub to: Option<i64>,
    /// 窗口终点末尾位点。用它判断「还有没有活可干」。
    pub high: i64,
}

impl PartitionShift {
    /// 分区是否在前进。
    pub fn moved(&self) -> bool {
        matches!((self.from, self.to), (Some(from), Some(to)) if to > from)
    }

    /// 该分区当前滞后。
    pub fn lag(&self) -> i64 {
        match self.to {
            Some(to) => (self.high - to).max(0),
            // 没有提交位点：整个分区都还没消费。
            None => self.high.max(0),
        }
    }

    /// 位点是否发生了回退（重置、组被重建、分区被截断）。
    pub fn regressed(&self) -> bool {
        matches!((self.from, self.to), (Some(from), Some(to)) if to < from)
    }
}

/// 队头阻塞的判定结果，直接给界面显示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockReport {
    /// 是否判定为阻塞。
    pub blocked: bool,
    /// 一句话结论。
    pub headline: String,
    /// 展开说明：为什么这么判、该看哪里。
    pub detail: String,
    /// 卡住的分区（`topic` + `partition` + 滞后量）。
    pub stuck: Vec<StuckPartition>,
    /// 整个组在这段时间里一条都没动：这不是阻塞，是没流量或者全部挂着。
    pub idle: bool,
    /// 位点回退的分区：它们的位移不能当依据。
    pub regressed: Vec<String>,
}

/// 卡住的分区。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StuckPartition {
    pub topic: String,
    pub partition: i32,
    /// 该分区剩余的滞后量。
    pub lag: i64,
    /// 被分配到这个分区的成员（客户端标识）；拿不到时为空。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
}

/// 判定阈值：卡住的分区至少要留下这么多滞后才算「有活干却没干」。
///
/// 留 1 条就够，但下游写入是持续的：把阈值定成「有滞后」会把
/// 「刚好差一条、下一秒就消费掉」也报成阻塞。给一个小余量。
pub const MIN_STUCK_LAG: i64 = 1;

/// 从两次详情快照判定队头阻塞。
///
/// `before` 是窗口起点的详情，`after` 是终点的。两次的分区集合可能不同
/// （窗口内扩容、组被重建），所以按 `(topic, partition)` 配对，只比共同的。
pub fn detect(
    before: &ConsumerGroupDetail,
    after: &ConsumerGroupDetail,
    assignment: &dyn Fn(&str, i32) -> Vec<String>,
) -> BlockReport {
    let shifts = pair(&before.offsets, &after.offsets);
    if shifts.is_empty() {
        return BlockReport {
            blocked: false,
            headline: "无法比较".to_owned(),
            detail: "两次采样的分区不重合：组可能刚被重建，或者窗口内分区全变了".to_owned(),
            stuck: Vec::new(),
            idle: false,
            regressed: Vec::new(),
        };
    }

    let regressed: Vec<String> = shifts
        .iter()
        .filter(|shift| shift.regressed())
        .map(|shift| format!("{}-{}", shift.topic, shift.partition))
        .collect();

    // 位点回退的分区不参与「谁在动」的判断：回退会被读成「巨大前进」或
    // 「巨大后退」，两种都是假信号。它们单独列出来说明。
    let usable: Vec<&PartitionShift> = shifts.iter().filter(|shift| !shift.regressed()).collect();

    let moved = usable.iter().filter(|shift| shift.moved()).count();
    let stuck: Vec<StuckPartition> = usable
        .iter()
        .filter(|shift| !shift.moved() && shift.lag() >= MIN_STUCK_LAG)
        .map(|shift| StuckPartition {
            topic: shift.topic.clone(),
            partition: shift.partition,
            lag: shift.lag(),
            members: assignment(&shift.topic, shift.partition),
        })
        .collect();

    if moved == 0 {
        // 整组没动：可能没流量，也可能全部成员都挂着。措辞不能说成「阻塞」——
        // 「没有流量」和「卡住了」在界面上的处置完全不同。
        let detail = if stuck.is_empty() {
            "窗口内所有分区都没有推进，但也没有剩余滞后：这段时间没有新消息".to_owned()
        } else {
            format!(
                "窗口内 {} 个分区都没有推进，共积压 {} 条；可能是全部成员都卡住，也可能这段时间根本没有新消息",
                usable.len(),
                stuck.iter().map(|item| item.lag).sum::<i64>()
            )
        };
        return BlockReport {
            blocked: false,
            headline: "整组未推进".to_owned(),
            detail,
            stuck,
            idle: true,
            regressed,
        };
    }

    if stuck.is_empty() {
        return BlockReport {
            blocked: false,
            headline: "没有队头阻塞".to_owned(),
            detail: format!("{moved} 个分区在推进，未发现「有滞后却不前进」的分区"),
            stuck: Vec::new(),
            idle: false,
            regressed,
        };
    }

    let total: i64 = stuck.iter().map(|item| item.lag).sum();
    let names: Vec<String> = stuck
        .iter()
        .map(|item| format!("{}-{}", item.topic, item.partition))
        .collect();
    BlockReport {
        blocked: true,
        headline: format!("{} 个分区卡住", stuck.len()),
        detail: format!(
            "{} 有 {} 条滞后但位点没动，而同期 {} 个分区在推进 —— 典型的分区内顺序消费被单条消息顶住（毒消息、下游超时、max.poll.records 过大）",
            names.join("、"),
            total,
            moved
        ),
        stuck,
        idle: false,
        regressed,
    }
}

/// 按 `(topic, partition)` 配对两次快照。
fn pair(before: &[ConsumerGroupOffset], after: &[ConsumerGroupOffset]) -> Vec<PartitionShift> {
    let mut shifts = Vec::new();
    for current in after {
        let Some(previous) = before
            .iter()
            .find(|item| item.topic == current.topic && item.partition == current.partition)
        else {
            // 窗口内新增的分区没有基线，猜一个「从 0 开始」会把它的全部滞后
            // 记成这段时间的积压。
            continue;
        };
        shifts.push(PartitionShift {
            topic: current.topic.clone(),
            partition: current.partition,
            from: previous.offset,
            to: current.offset,
            high: current.high,
        });
    }
    shifts.sort_by(|a, b| a.topic.cmp(&b.topic).then(a.partition.cmp(&b.partition)));
    shifts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::consumer::{ConsumerGroupInfo, ConsumerGroupMember};

    fn offset(topic: &str, partition: i32, offset: Option<i64>, high: i64) -> ConsumerGroupOffset {
        ConsumerGroupOffset {
            topic: topic.to_owned(),
            partition,
            offset,
            high,
            lag: offset.map_or(high, |value| (high - value).max(0)),
        }
    }

    fn detail(offsets: Vec<ConsumerGroupOffset>) -> ConsumerGroupDetail {
        let lag: i64 = offsets.iter().map(|item| item.lag).sum();
        let members = vec![ConsumerGroupMember {
            member_id: Some("m-1".to_owned()),
            client_id: Some("worker-1".to_owned()),
            client_host: None,
        }];
        ConsumerGroupDetail {
            group: ConsumerGroupInfo {
                name: "orders-worker".to_owned(),
                state: "Stable".to_owned(),
                members: 1,
                total_lag: Some(lag),
            },
            members,
            offsets,
        }
    }

    fn no_assignment(_topic: &str, _partition: i32) -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn stuck_partition_while_others_advance_is_blocked() {
        let before = detail(vec![
            offset("orders", 0, Some(10), 20),
            offset("orders", 1, Some(10), 1000),
        ]);
        let after = detail(vec![
            offset("orders", 0, Some(20), 20),
            offset("orders", 1, Some(10), 1000),
        ]);
        let report = detect(&before, &after, &no_assignment);
        assert!(report.blocked);
        assert_eq!(report.stuck.len(), 1);
        assert_eq!(report.stuck[0].partition, 1);
        assert_eq!(report.stuck[0].lag, 990);
        assert!(report.detail.contains("卡住") || report.detail.contains("滞后"));
    }

    #[test]
    fn whole_group_idle_is_not_called_blocked() {
        let before = detail(vec![offset("orders", 0, Some(10), 30)]);
        let after = detail(vec![offset("orders", 0, Some(10), 30)]);
        let report = detect(&before, &after, &no_assignment);
        // 没有流量时滞后不变是正常的，说成「阻塞」会让人白查一轮。
        assert!(!report.blocked);
        assert!(report.idle);
    }

    #[test]
    fn empty_partition_is_not_stuck() {
        let before = detail(vec![
            offset("orders", 0, Some(10), 20),
            offset("orders", 1, Some(50), 50),
        ]);
        let after = detail(vec![
            offset("orders", 0, Some(20), 20),
            offset("orders", 1, Some(50), 50),
        ]);
        let report = detect(&before, &after, &no_assignment);
        assert!(!report.blocked);
        assert!(report.stuck.is_empty());
    }

    #[test]
    fn regressed_partition_is_excluded_from_verdict() {
        let before = detail(vec![
            offset("orders", 0, Some(100), 200),
            offset("orders", 1, Some(10), 500),
        ]);
        // 分区 0 的位点被重置回 5：算出来是「巨大滞后」，不能当卡住的证据。
        let after = detail(vec![
            offset("orders", 0, Some(5), 200),
            offset("orders", 1, Some(15), 500),
        ]);
        let report = detect(&before, &after, &no_assignment);
        assert_eq!(report.regressed, vec!["orders-0".to_owned()]);
        assert!(report.stuck.iter().all(|item| item.partition != 0));
    }

    #[test]
    fn new_partition_without_baseline_is_ignored() {
        let before = detail(vec![offset("orders", 0, Some(10), 20)]);
        let after = detail(vec![
            offset("orders", 0, Some(20), 20),
            offset("orders", 1, None, 900),
        ]);
        let report = detect(&before, &after, &no_assignment);
        // 分区 1 在窗口内才出现，没有基线，不能把它的 900 条当成积压。
        assert!(report.stuck.is_empty());
        assert!(!report.blocked);
    }

    #[test]
    fn no_overlapping_partitions_reports_unknown() {
        let before = detail(vec![offset("a", 0, Some(1), 2)]);
        let after = detail(vec![offset("b", 0, Some(1), 2)]);
        let report = detect(&before, &after, &no_assignment);
        assert!(!report.blocked);
        assert_eq!(report.headline, "无法比较");
    }

    #[test]
    fn assignment_is_attached_to_stuck_partition() {
        let before = detail(vec![
            offset("orders", 0, Some(1), 2),
            offset("orders", 1, Some(1), 9),
        ]);
        let after = detail(vec![
            offset("orders", 0, Some(2), 2),
            offset("orders", 1, Some(1), 9),
        ]);
        let report = detect(&before, &after, &|topic, partition| {
            if topic == "orders" && partition == 1 {
                vec!["worker-2".to_owned()]
            } else {
                Vec::new()
            }
        });
        assert_eq!(report.stuck[0].members, vec!["worker-2".to_owned()]);
    }
}
