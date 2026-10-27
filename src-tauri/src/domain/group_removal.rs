//! 删除消费组之前的预检：把「哪些组会被服务端拒绝」提前说清楚。
//!
//! 删除组本身只有一个服务端守卫 —— `NonEmptyGroup`：组里还有在线成员就拒绝。
//! 问题在于那个错误是**一条一条回执的**，用户点了删除、等一个
//! `delete_groups` 往返，才知道这批里有一半删不掉。批量勾选的时候这尤其难用：
//! 界面上给不出「先停掉哪几个消费者」的动作，因为结果回来之前没人知道是谁。
//!
//! 所以这里在提交之前先读一次组成员，按 `NonEmptyGroup` 的规则预判，
//! 让确认框直接说明「这个组现在删不掉、被谁占着」。
//!
//! 三条刻意的边界：
//!
//! 1. **只是预判，不是保证**。读完成员到真正删除之间有窗口，成员可能刚好上线。
//!    所以这里从不返回「可以删」，只返回「会被拒绝」和「没看出问题」。
//! 2. **读不到成员不算拦路**。组名不存在、权限不足、读取失败都放进 `unknown`
//!    并附原因 —— 把「我不知道」说成「不能删」，会让一次正常的删除被拦住。
//! 3. **不做本地去重之外的任何清理**。这一层是纯函数，不碰网络。

use serde::{Deserialize, Serialize};

use super::broker::KeyValue;
use super::consumer::{ConsumerGroupDetail, ConsumerGroupMember};

/// 一个组的预检结论。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRemovalCheck {
    /// 组名（已去空白）。
    pub group: String,
    /// 预判会被服务端拒绝：组里还有在线成员。
    pub blocked: bool,
    /// 一句话说明，直接给用户看。
    pub reason: String,
    /// 在线成员数；读不到成员时为 `None`（不是 0）。
    pub members: Option<usize>,
    /// 成员明细。界面只列前几个，剩下的用计数带过。
    pub member_details: Vec<ConsumerGroupMember>,
    /// 已提交位点的分区数：删掉之后这些进度全部消失。
    pub offsets: usize,
}

impl GroupRemovalCheck {
    /// 在线成员占着的组：现在删不掉。
    fn blocked_by(detail: &ConsumerGroupDetail) -> Self {
        let count = detail.members.len();
        Self {
            group: detail.group.name.clone(),
            blocked: true,
            reason: format!(
                "组里还有 {count} 个在线成员，服务端会拒绝删除（NonEmptyGroup）；先停掉这些消费者再重试"
            ),
            members: Some(count),
            member_details: detail.members.clone(),
            offsets: detail.offsets.len(),
        }
    }

    /// 读到了成员，但眼下没看出问题。
    fn clear(detail: &ConsumerGroupDetail) -> Self {
        let offsets = detail.offsets.len();
        Self {
            group: detail.group.name.clone(),
            blocked: false,
            reason: if offsets == 0 {
                "没有在线成员，也没有已提交位点：删掉它不会丢进度".to_owned()
            } else {
                format!("没有在线成员；删掉后这 {offsets} 个分区的已提交位点会一起消失")
            },
            members: Some(0),
            member_details: Vec::new(),
            offsets,
        }
    }

    /// 读不到成员时占位。`reason` 必须是原因，不是结论。
    fn unknown(group: &str, reason: String) -> Self {
        Self {
            group: group.to_owned(),
            // 不敢说「能删」：读不到成员时唯一诚实的取值是「没看出问题」。
            blocked: false,
            reason,
            members: None,
            member_details: Vec::new(),
            offsets: 0,
        }
    }
}

/// 一次预检的结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRemovalPreflight {
    /// 勾选的组是否被本地拦下（有在线成员）。
    pub has_blocked: bool,
    /// 一句话结论。
    pub headline: String,
    /// 逐组结论，顺序与请求一致（去空白、去重、排序后）。
    pub groups: Vec<GroupRemovalCheck>,
    /// 读不到状态的组及原因。这些组**不**参与拦截。
    pub unknown: Vec<KeyValue>,
}

impl GroupRemovalPreflight {
    /// 从逐组结论拼出总结。
    ///
    /// 措辞上把「能删」和「没什么可删」分开：一个只有内部主题的集群照样会
    /// 出现「0 个组」，但那是另一件事。
    pub fn from_checks(groups: Vec<GroupRemovalCheck>) -> Self {
        let blocked: Vec<&GroupRemovalCheck> =
            groups.iter().filter(|check| check.blocked).collect();
        let offsets: usize = groups
            .iter()
            .filter(|check| !check.blocked)
            .map(|check| check.offsets)
            .sum();

        let headline = if blocked.is_empty() {
            if offsets == 0 {
                format!("{} 个组都没看出问题，删掉不会丢进度", groups.len())
            } else {
                format!(
                    "{} 个组都没看出问题；删掉会丢 {} 个分区的已提交位点",
                    groups.len(),
                    offsets
                )
            }
        } else if blocked.len() == groups.len() {
            format!(
                "{} 个组都还有在线成员，服务端会全部拒绝；先停掉消费者",
                blocked.len()
            )
        } else {
            format!(
                "{} 个组里 {} 个还有在线成员，会被服务端拒绝；其余 {} 个可以删",
                groups.len(),
                blocked.len(),
                groups.len() - blocked.len()
            )
        };

        Self {
            has_blocked: !blocked.is_empty(),
            headline,
            groups,
            unknown: Vec::new(),
        }
    }
}

/// 整批都没读到状态时的占位：不拦，但把原因摆出来。
pub fn all_unknown(groups: &[String], reason: String) -> GroupRemovalPreflight {
    GroupRemovalPreflight {
        has_blocked: false,
        headline: format!(
            "{} 个组的成员状态都读不到，无法预判；删除结果以服务端回执为准",
            groups.len()
        ),
        groups: Vec::new(),
        unknown: groups
            .iter()
            .map(|name| KeyValue::new(name.clone(), reason.clone()))
            .collect(),
    }
}

/// 单个组的预检：有在线成员就是 `blocked`。
///
/// 不看 `state`：`Empty` / `Dead` 与成员数通常一致，但组状态是**上一次
/// 协调者心跳**留下的快照，成员刚上线时还可能写着 `Empty`。以成员列表为准，
/// 因为服务端的 `NonEmptyGroup` 判的也是成员。
pub fn check(detail: &ConsumerGroupDetail) -> GroupRemovalCheck {
    if detail.members.is_empty() {
        GroupRemovalCheck::clear(detail)
    } else {
        GroupRemovalCheck::blocked_by(detail)
    }
}

/// 组名规范化：去空白、丢空串、去重、排序。
///
/// 与 `delete_consumer_groups` 共用同一套规则 —— 预检和实际提交必须
/// 面对同一份名单，否则「预检 3 个、删了 5 个」这种事迟早会发生。
pub fn normalize_names(groups: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = groups
        .into_iter()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}

/// 把逐组检查与读失败的组拼成完整结果。
pub fn assemble(checks: Vec<GroupRemovalCheck>, unknown: Vec<KeyValue>) -> GroupRemovalPreflight {
    let mut preflight = GroupRemovalPreflight::from_checks(checks);
    preflight.unknown = unknown;
    preflight
}

/// 读不到成员时的占位，暴露给 `message` 层用。
pub fn unknown_check(group: &str, reason: String) -> GroupRemovalCheck {
    GroupRemovalCheck::unknown(group, reason)
}

#[cfg(test)]
mod tests {
    use super::super::consumer::ConsumerGroupOffset;
    use super::*;

    fn member(id: &str) -> ConsumerGroupMember {
        ConsumerGroupMember {
            member_id: Some(id.to_owned()),
            client_id: None,
            client_host: None,
        }
    }

    fn offset(topic: &str, partition: i32) -> ConsumerGroupOffset {
        ConsumerGroupOffset {
            topic: topic.to_owned(),
            partition,
            offset: Some(10),
            high: 20,
            lag: 10,
        }
    }

    fn detail(
        name: &str,
        members: Vec<ConsumerGroupMember>,
        offsets: usize,
    ) -> ConsumerGroupDetail {
        ConsumerGroupDetail {
            group: super::super::consumer::ConsumerGroupInfo {
                name: name.to_owned(),
                state: "Empty".to_owned(),
                members: members.len(),
                total_lag: None,
            },
            members,
            offsets: (0..offsets as i32).map(|p| offset("orders", p)).collect(),
        }
    }

    #[test]
    fn group_with_members_is_blocked() {
        let check = check(&detail("orders", vec![member("m-1"), member("m-2")], 4));
        assert!(check.blocked);
        assert_eq!(check.members, Some(2));
        assert_eq!(check.member_details.len(), 2);
        // 说明里必须给出下一步动作，而不是只报错误码。
        assert!(check.reason.contains("NonEmptyGroup"));
        assert!(check.reason.contains("先停掉"));
    }

    #[test]
    fn empty_group_carries_no_warning_about_members() {
        let check = check(&detail("orders", Vec::new(), 3));
        assert!(!check.blocked);
        assert_eq!(check.members, Some(0));
        // 丢进度这件事必须说出来：3 个分区的位点会一起消失。
        assert!(check.reason.contains("3 个分区"));
        assert!(check.reason.contains("一起消失"));
    }

    #[test]
    fn empty_group_without_offsets_says_nothing_is_lost() {
        let check = check(&detail("orders", Vec::new(), 0));
        assert!(!check.blocked);
        assert!(check.reason.contains("不会丢进度"));
    }

    #[test]
    fn unknown_member_state_never_blocks() {
        // 读不到成员时，唯一诚实的取值是「没看出问题」。
        let check = unknown_check("orders", "连接超时".to_owned());
        assert!(!check.blocked);
        assert_eq!(check.members, None, "读不到成员时不该报成 0");
        assert_eq!(check.reason, "连接超时");
    }

    #[test]
    fn mixed_batch_reports_both_sides() {
        let mut checked = vec![
            check(&detail("a", vec![member("m-1")], 0)),
            check(&detail("b", Vec::new(), 2)),
        ];
        checked.sort_by(|left, right| left.group.cmp(&right.group));
        let preflight = GroupRemovalPreflight::from_checks(checked);
        assert!(preflight.has_blocked);
        assert!(preflight.headline.contains("2 个组里 1 个"));
        assert!(preflight.headline.contains("其余 1 个可以删"));
    }

    #[test]
    fn all_clear_batch_counts_lost_offsets() {
        let preflight = GroupRemovalPreflight::from_checks(vec![
            check(&detail("a", Vec::new(), 2)),
            check(&detail("b", Vec::new(), 3)),
        ]);
        assert!(!preflight.has_blocked);
        assert!(preflight.headline.contains("会丢 5 个分区的已提交位点"));
    }

    #[test]
    fn batch_without_offsets_says_nothing_is_lost() {
        let preflight =
            GroupRemovalPreflight::from_checks(vec![check(&detail("a", Vec::new(), 0))]);
        assert!(preflight.headline.contains("不会丢进度"));
    }

    #[test]
    fn every_group_blocked_says_so() {
        let preflight = GroupRemovalPreflight::from_checks(vec![
            check(&detail("a", vec![member("m-1")], 0)),
            check(&detail("b", vec![member("m-2")], 0)),
        ]);
        assert!(preflight.has_blocked);
        assert!(preflight.headline.contains("都还有在线成员"));
        assert!(preflight.headline.contains("全部拒绝"));
    }

    #[test]
    fn unknown_groups_are_reported_separately() {
        let preflight = assemble(
            vec![
                check(&detail("a", Vec::new(), 0)),
                unknown_check("b", "组 b 不存在".to_owned()),
            ],
            vec![KeyValue::new("b", "组 b 不存在")],
        );
        assert!(!preflight.has_blocked);
        assert_eq!(preflight.unknown.len(), 1);
        assert_eq!(preflight.groups.len(), 2);
    }

    #[test]
    fn total_failure_still_returns_a_preflight() {
        // 整批读不到：不能变成错误态，更不能拦人。
        let report = all_unknown(&["a".to_owned(), "b".to_owned()], "连不上".to_owned());
        assert!(!report.has_blocked);
        assert!(report.groups.is_empty());
        assert_eq!(report.unknown.len(), 2);
        assert!(report.headline.contains("以服务端回执为准"));
    }

    #[test]
    fn names_are_trimmed_deduped_and_sorted() {
        let names = normalize_names(vec![
            "  orders ".to_owned(),
            "orders".to_owned(),
            "".to_owned(),
            "payments".to_owned(),
        ]);
        assert_eq!(names, vec!["orders".to_owned(), "payments".to_owned()]);
    }
}
