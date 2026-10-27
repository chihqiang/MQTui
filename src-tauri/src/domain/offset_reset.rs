//! Kafka 消费组位点重置的规则。
//!
//! 这是面板里**最容易造成数据事故**的一个动作：把位点调小 = 重放历史，
//! 调大 = 跳过消息。两者都不可撤销，而且消费方通常毫不知情。
//!
//! 因此这里的产出不是「一个要执行的命令」，而是三层：
//!
//! 1. `preview()`：先算出「每个分区会从哪个位点开始」的完整对照，
//!    用户在按下确认之前能看到全部后果；
//! 2. `blockers()`：不满足执行条件时**不执行**，并把原因写清楚；
//! 3. `step()` 的执行顺序：先停消费者，再改位点 —— 反过来的话
//!    正在运行的消费者会在位点被改写后立刻又提交一次旧进度，改动等于白做。
//!
//! 全部是纯函数，不碰网络。Kafka 侧只负责把「分区当前位点 / 最早 / 末尾」喂进来。

use serde::{Deserialize, Serialize};

/// 重置目标：从哪个位置开始消费。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetTarget {
    /// 最早可用的位点（重放全部保留的消息）。
    Earliest,
    /// 末尾位点（跳过全部积压）。
    Latest,
    /// 指定时间：取该时间之后的第一条消息。
    Timestamp,
    /// 精确位点，按分区逐条指定。
    Offset,
}

impl ResetTarget {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Earliest => "最早位点",
            Self::Latest => "末尾位点",
            Self::Timestamp => "按时间",
            Self::Offset => "精确位点",
        }
    }

    /// 逐条指定偏移量的模式没有「批量」语义，必须带分区列表。
    pub const fn needs_offsets(self) -> bool {
        matches!(self, Self::Offset)
    }
}

/// 一个分区的现状与目标。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionState {
    pub partition: i32,
    /// 当前已提交位点；从未提交过时为 `None`。
    pub committed: Option<i64>,
    /// 最早可用位点。
    pub earliest: i64,
    /// 末尾位点（下一条将被写入的位置）。
    pub latest: i64,
}

impl PartitionState {
    /// 按位点算出的积压量：末尾 - 已提交。从未提交过时以最早位点计。
    pub fn lag(&self) -> i64 {
        let from = self.committed.unwrap_or(self.earliest);
        (self.latest - from).max(0)
    }
}

/// 一个分区的重置计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetStep {
    pub partition: i32,
    /// 当前位点（`None` = 从未提交）。
    pub from: Option<i64>,
    /// 目标位点。
    pub to: i64,
    /// 这次改动会重放（正）还是跳过（负）多少条消息。
    ///
    /// 正数 = 会重复消费这么多条，负数 = 会跳过这么多条。
    /// 界面必须把这个数字显示出来：「把位点改到最早」听上去无害，
    /// 实际上可能意味着几十万条消息重新投给下游。
    pub delta: i64,
    /// 是否真的有变化。无变化的分区不该出现在提交列表里。
    pub changed: bool,
}

/// 重置计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPlan {
    pub target: ResetTarget,
    pub target_label: String,
    pub steps: Vec<ResetStep>,
    /// 改动后会被重放的消息总数。
    pub replay: i64,
    /// 改动后会被跳过的消息总数。
    pub skip: i64,
    /// 不满足执行条件的原因。非空时禁止执行。
    pub blockers: Vec<String>,
    /// 执行前的注意事项，按顺序展示。
    pub notes: Vec<String>,
}

impl ResetPlan {
    /// 计划是否可以执行。
    pub fn is_executable(&self) -> bool {
        self.blockers.is_empty() && self.steps.iter().any(|step| step.changed)
    }

    /// 真正需要提交的分区（位点有变化的那些）。
    pub fn changes(&self) -> Vec<&ResetStep> {
        self.steps.iter().filter(|step| step.changed).collect()
    }
}

/// 生成重置计划的入参。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetRequest<'a> {
    pub group: &'a str,
    pub topic: &'a str,
    pub target: ResetTarget,
    /// `ResetTarget::Offset` 时使用：`(partition, offset)`。
    pub offsets: &'a [(i32, i64)],
    /// `ResetTarget::Timestamp` 时使用：每个分区的目标位点已由调用方按时间反查得出。
    pub timestamp_offsets: &'a [(i32, i64)],
    /// 该消费组当前是否有活跃成员。
    pub has_active_members: bool,
}

/// 计算重置计划。
pub fn preview(request: &ResetRequest<'_>, states: &[PartitionState]) -> ResetPlan {
    let mut notes = Vec::new();
    let mut blockers = Vec::new();

    if request.has_active_members {
        notes.push(
            "该消费组仍有活跃成员：位点改动会被它们的下一次自动提交覆盖，务必先停掉消费者"
                .to_owned(),
        );
    }

    if states.is_empty() {
        blockers.push("该消费组没有提交过任何分区位点，无法重置".to_owned());
    }

    let explicit = match request.target {
        ResetTarget::Offset => Some(request.offsets),
        ResetTarget::Timestamp => Some(request.timestamp_offsets),
        _ => None,
    };

    if request.target.needs_offsets() && explicit.is_some_and(<[_]>::is_empty) {
        blockers.push(format!(
            "「{}」需要逐分区给定目标位点，当前为空",
            request.target.label()
        ));
    }

    let mut steps = Vec::with_capacity(states.len());
    let mut replay = 0i64;
    let mut skip = 0i64;

    for state in states {
        let target = match request.target {
            ResetTarget::Earliest => Some(state.earliest),
            ResetTarget::Latest => Some(state.latest),
            ResetTarget::Timestamp | ResetTarget::Offset => explicit
                .and_then(|items| {
                    items
                        .iter()
                        .find(|(partition, _)| *partition == state.partition)
                })
                .map(|(_, offset)| *offset),
        };

        let Some(to) = target else {
            // 逐分区模式下没给出目标的分区：不猜，直接标成「不改动」。
            // 猜一个位点等于替用户决定重放多少数据。
            if request.target.needs_offsets() {
                steps.push(ResetStep {
                    partition: state.partition,
                    from: state.committed,
                    to: state.committed.unwrap_or(state.earliest),
                    delta: 0,
                    changed: false,
                });
                continue;
            }
            steps.push(ResetStep {
                partition: state.partition,
                from: state.committed,
                to: state.committed.unwrap_or(state.earliest),
                delta: 0,
                changed: false,
            });
            continue;
        };

        // 目标位点必须落在 [earliest, latest] 内：越界的位置 Kafka 会直接拒绝，
        // 但错误发生在提交阶段就太晚了 —— 前几个分区已经改掉了。
        if to < state.earliest || to > state.latest {
            blockers.push(format!(
                "分区 {} 的目标位点 {to} 超出可用范围 [{}, {}]",
                state.partition, state.earliest, state.latest
            ));
        }

        let clamped = to.clamp(state.earliest, state.latest);
        let from = state.committed;
        let base = from.unwrap_or(state.earliest);
        let delta = clamped - base;

        if delta > 0 {
            skip += delta;
        } else {
            replay += -delta;
        }

        steps.push(ResetStep {
            partition: state.partition,
            from,
            to: clamped,
            delta,
            changed: delta != 0,
        });
    }

    steps.sort_by_key(|step| step.partition);

    if !steps.iter().any(|step| step.changed) && blockers.is_empty() {
        notes.push("所有分区的目标位点与当前一致，提交后不会有任何变化".to_owned());
    }
    if replay > 0 {
        notes.push(format!(
            "将有 {replay} 条历史消息被重新投递给消费组，下游会收到重复消息"
        ));
    }
    if skip > 0 {
        notes.push(format!("将有 {skip} 条消息被跳过，不会再被消费"));
    }

    ResetPlan {
        target: request.target,
        target_label: request.target.label().to_owned(),
        steps,
        replay,
        skip,
        blockers,
        notes,
    }
}

/// 执行顺序里的一句提示：哪一步、为什么必须在这个位置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPhase {
    pub order: usize,
    pub title: String,
    pub detail: String,
}

/// 固定的三段式执行顺序。
///
/// 顺序不是风格问题：位点提交必须发生在消费者停止之后、恢复之前。
/// 把这个顺序写进领域层，是为了让界面上的说明与后端的实际动作同源。
pub fn phases(group: &str, has_active_members: bool) -> Vec<ResetPhase> {
    vec![
        ResetPhase {
            order: 1,
            title: "停止消费者".to_owned(),
            detail: if has_active_members {
                format!("消费组 {group} 仍有活跃成员，请先停掉它们，否则位点会被自动提交覆盖")
            } else {
                format!("消费组 {group} 当前无活跃成员，可直接提交位点")
            },
        },
        ResetPhase {
            order: 2,
            title: "提交新位点".to_owned(),
            detail: "按预览里的分区对照逐个提交；中途失败会报出已提交的分区数，不会静默回滚"
                .to_owned(),
        },
        ResetPhase {
            order: 3,
            title: "恢复消费者".to_owned(),
            detail: "消费者重启后会从新位点继续；有重放时下游需要按幂等处理重复消息".to_owned(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states() -> Vec<PartitionState> {
        vec![
            PartitionState {
                partition: 0,
                committed: Some(50),
                earliest: 0,
                latest: 100,
            },
            PartitionState {
                partition: 1,
                committed: None,
                earliest: 10,
                latest: 30,
            },
        ]
    }

    fn request(target: ResetTarget) -> ResetRequest<'static> {
        ResetRequest {
            group: "orders",
            topic: "orders",
            target,
            offsets: &[],
            timestamp_offsets: &[],
            has_active_members: false,
        }
    }

    #[test]
    fn earliest_replays_everything_retained() {
        let plan = preview(&request(ResetTarget::Earliest), &states());
        // 分区 0 已提交 50 → 回到 0，重放 50 条；
        // 分区 1 从未提交过，它本来就会从最早位点开始读，没有「重放」可言。
        assert_eq!(plan.replay, 50);
        assert_eq!(plan.skip, 0);
        assert!(
            !plan
                .steps
                .iter()
                .any(|step| step.partition == 1 && step.changed)
        );
        assert!(plan.is_executable());
    }

    #[test]
    fn latest_skips_all_backlog() {
        let plan = preview(&request(ResetTarget::Latest), &states());
        assert_eq!(plan.skip, 70);
        assert_eq!(plan.replay, 0);
    }

    #[test]
    fn partition_without_committed_offset_counts_from_earliest() {
        let plan = preview(&request(ResetTarget::Latest), &states());
        let second = plan.steps.iter().find(|step| step.partition == 1).unwrap();
        assert_eq!(second.from, None);
        assert_eq!(second.delta, 20);
        assert!(second.changed);
    }

    #[test]
    fn out_of_range_offset_blocks_instead_of_silently_clamping() {
        let offsets = [(0, 500)];
        let request = ResetRequest {
            offsets: &offsets,
            ..request(ResetTarget::Offset)
        };
        let plan = preview(&request, &states());
        assert!(!plan.is_executable());
        assert!(
            plan.blockers
                .iter()
                .any(|item| item.contains("超出可用范围"))
        );
    }

    #[test]
    fn explicit_mode_without_offsets_is_blocked() {
        let plan = preview(&request(ResetTarget::Offset), &states());
        assert!(!plan.is_executable());
    }

    #[test]
    fn explicit_mode_leaves_unlisted_partitions_untouched() {
        let offsets = [(0, 0)];
        let request = ResetRequest {
            offsets: &offsets,
            ..request(ResetTarget::Offset)
        };
        let plan = preview(&request, &states());
        let second = plan.steps.iter().find(|step| step.partition == 1).unwrap();
        assert!(!second.changed);
        // 没给目标的分区不能凭空算出一个位点。
        assert_eq!(second.to, 10);
    }

    #[test]
    fn empty_states_is_blocked() {
        let plan = preview(&request(ResetTarget::Earliest), &[]);
        assert!(!plan.is_executable());
    }

    #[test]
    fn active_members_produce_a_warning_note() {
        let request = ResetRequest {
            has_active_members: true,
            ..request(ResetTarget::Earliest)
        };
        let plan = preview(&request, &states());
        assert!(plan.notes.iter().any(|note| note.contains("活跃成员")));
        // 只是提醒，不阻断：能不能停消费者由用户决定。
        assert!(plan.is_executable());
    }

    #[test]
    fn no_change_plan_is_not_executable() {
        let states = [PartitionState {
            partition: 0,
            committed: Some(100),
            earliest: 0,
            latest: 100,
        }];
        let plan = preview(&request(ResetTarget::Latest), &states);
        assert!(!plan.is_executable());
        assert!(
            plan.notes
                .iter()
                .any(|note| note.contains("不会有任何变化"))
        );
    }

    #[test]
    fn phases_mention_group_and_order_is_stable() {
        let steps = phases("orders", true);
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].order, 1);
        assert!(steps[0].detail.contains("orders"));
    }

    #[test]
    fn lag_uses_earliest_when_never_committed() {
        let state = PartitionState {
            partition: 0,
            committed: None,
            earliest: 10,
            latest: 30,
        };
        assert_eq!(state.lag(), 20);
    }
}
