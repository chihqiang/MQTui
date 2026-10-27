//! Kafka 消费组相关的领域模型。
//!
//! 消费组是 Kafka 独有的概念，因此模型放在独立文件里，
//! 不往 `message` / `broker` 的通用的结构体上加可选字段。

use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
