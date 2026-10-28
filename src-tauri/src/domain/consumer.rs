//! Kafka 消费组相关的领域模型。
//!
//! 消费组是 Kafka 独有的概念，因此模型放在独立文件里，
//! 不往 `message` / `broker` 的通用的结构体上加可选字段。

use serde::{Deserialize, Serialize};

use super::group_assignment::GroupAssignment;

/// 消费组概况，对应 `list_consumer_groups` 的一行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupInfo {
    pub name: String,
    /// `Stable` / `Empty` / `Dead` / `PreparingRebalance` 等，由服务端原样给出。
    pub state: String,
    /// 组成员数（消费者实例数）。
    pub members: usize,
    /// 组内所有分区滞后量之和。成员不在线时服务端无法计算，为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lag: Option<i64>,
}

/// 消费组详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupDetail {
    pub group: ConsumerGroupInfo,
    pub members: Vec<ConsumerGroupMember>,
    pub offsets: Vec<ConsumerGroupOffset>,
}

/// 消费组内的一个成员。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupMember {
    /// 服务端分配的成员 ID。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    /// 客户端自定义的实例标识（`group.instance.id`），静态成员才有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_host: Option<String>,
}

/// 消费组在某个分区上的进度。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupOffset {
    pub topic: String,
    pub partition: i32,
    /// 已提交的位点，未提交时为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    /// 分区末尾位点，即「最新可读位置」。
    pub high: i64,
    /// 滞后条数为 `high - offset`；没有提交位点时退回 `high - low`。
    ///
    /// 位点被清理（retention）后可能小于 `low`，此时滞后量按 0 计，避免出现负数。
    pub lag: i64,
}

/// 这个组状态说明它「提交过位点」。
///
/// 只有 `Empty` 是确定的：它意味着组里有提交记录、只是当前没有成员（Kafka 的组
/// 在最后一个成员离开后还会保留 `__consumer_offsets` 里那一条，状态因此是 `Empty`
/// 而不是消失）。`Stable` / `PreparingRebalance` 这类必然读过消息。
///
/// `Dead` 与空串走 `false`：前者是「这个组不存在」，后者是服务端没给状态 ——
/// 两种情况都不该被读成「组存在，只是没消费过」。
pub fn group_has_committed(state: &str) -> bool {
    matches!(
        state.trim().to_ascii_lowercase().as_str(),
        "stable"
            | "empty"
            | "preparingrebalance"
            | "completingrebalance"
            | "assigning"
            | "reconciling"
    )
}

/// 「组在，但一个分区都没提交过」时的说明。
///
/// 必须与「组名写错」分开：前者要去查消费端为什么不提交（订阅没配上、
/// 一直在再均衡、`enable.auto.commit` 关了又没手动提交），后者只要改个名字。
/// 两句合成一句「没有可查询的分区」，用户会先怀疑自己的客户端。
pub fn no_commit_detail(group: &str, assignment: &GroupAssignment) -> String {
    let hints: Vec<String> = assignment
        .notes
        .iter()
        .filter(|note| !note.trim().is_empty())
        .cloned()
        .collect();
    let tail = if hints.is_empty() {
        String::new()
    } else {
        format!("（{}）", hints.join("；"))
    };
    format!(
        "消费组 {group} 存在，但它没有提交过任何分区位点{tail}：\
         常见原因是订阅还没配上、组一直在再均衡，或者自动提交被关掉又没手动提交。\
         这不是组名的问题，滞后量现在还算不出来"
    )
}

/// 消费组名字列表查询条件。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupQuery {
    /// 按名称过滤，空表示不过滤。Kafka 侧走服务端前缀匹配，再在本地做包含匹配。
    #[serde(default)]
    pub keyword: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_live_group_states_count_as_committed() {
        // `Empty` 意味着组里有提交记录、只是当前没有成员 —— 这是最常见的
        // 「定时任务停了」那种组，不能当成「组名写错」。
        for state in ["Stable", "Empty", "PreparingRebalance", "EMPTY"] {
            assert!(group_has_committed(state), "{state} 应当被当成存在过的组");
        }
        // `Dead` / 空状态：前者是「这个组不存在」，后者是服务端没给状态。
        for state in ["Dead", "  ", "Unknown-New-State"] {
            assert!(
                !group_has_committed(state),
                "{state} 不该被读成「存在但没消费」"
            );
        }
    }

    #[test]
    fn no_commit_detail_is_not_confused_with_a_typo() {
        // 回归：组名写错时界面只说「没有可查询的分区」，读起来完全像
        // 「组在线、只是成员没分配分区」，排查方向立刻跑到消费端去。
        let assignment = GroupAssignment {
            by_member: Vec::new(),
            notes: Vec::new(),
        };
        let text = no_commit_detail("orders-worker", &assignment);
        assert!(text.contains("orders-worker"));
        assert!(text.contains("没有提交过任何分区位点"));
        assert!(text.contains("不是组名的问题"));
    }

    #[test]
    fn detail_serializes_camel_case() {
        let detail = ConsumerGroupDetail {
            group: ConsumerGroupInfo {
                name: "orders-worker".to_owned(),
                state: "Stable".to_owned(),
                members: 1,
                total_lag: Some(42),
            },
            members: vec![ConsumerGroupMember {
                member_id: None,
                client_id: Some("worker-1".to_owned()),
                client_host: None,
            }],
            offsets: vec![ConsumerGroupOffset {
                topic: "orders".to_owned(),
                partition: 0,
                offset: Some(10),
                high: 52,
                lag: 42,
            }],
        };

        let json = serde_json::to_value(&detail).expect("序列化失败");
        assert_eq!(json["group"]["totalLag"], 42);
        assert!(json["members"][0].get("memberId").is_none());
        assert_eq!(json["offsets"][0]["high"], 52);
    }
}
