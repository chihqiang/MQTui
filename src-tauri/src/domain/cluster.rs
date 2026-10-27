//! RabbitMQ 集群与运行时状态的领域模型。
//!
//! Kafka 那边 `broker/kafka/cluster.rs` 也复用了本文件的 `ClusterNode`，
//! 因为「节点名 + 角色 + 是否存活」这件事两个中间件是一回事：
//! 判读规则不同，展示结构相同。字段命名与 `src/types/cluster.ts` 一致。

use serde::{Deserialize, Serialize};

/// 节点在集群中的角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeRole {
    /// 可读写的普通节点。
    Member,
    /// RabbitMQ 的磁盘节点（元数据落盘），集群里至少需要一个。
    Disc,
    /// RabbitMQ 的 RAM 节点（元数据只在内存）。
    Ram,
    /// 集群当前选出的控制节点 / KRaft 的 active controller。
    Controller,
    /// Kafka 中处于「不可用 / 已下线」状态的 broker。
    Offline,
}

impl NodeRole {
    /// 展示文案。前端不自己拼中文，避免同一角色在两处翻译不一致。
    pub const fn label(self) -> &'static str {
        match self {
            Self::Member => "成员",
            Self::Disc => "磁盘节点",
            Self::Ram => "内存节点",
            Self::Controller => "控制节点",
            Self::Offline => "离线",
        }
    }

    /// `running` 为假时角色无意义，统一按离线报告。
    pub const fn of_running(running: bool, role: Self) -> Self {
        if running { role } else { Self::Offline }
    }
}

/// 集群中的一个节点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterNode {
    pub name: String,
    pub role: NodeRole,
    /// 角色文案，由后端给出，前端直接显示。
    pub role_label: String,
    /// 节点是否在运行。RabbitMQ 的 `running`、Kafka 的 broker 存活状态都落在这里。
    pub running: bool,
    /// 节点地址（`host:port`）。RabbitMQ 的节点名本身带 `@host`，这里额外给可直连的地址。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// 该节点上承载的队列数（RabbitMQ 才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queues: Option<u64>,
    /// 该节点是否为分区副本的 leader 数量（Kafka 才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leaders: Option<usize>,
}

impl ClusterNode {
    pub fn new(name: impl Into<String>, role: NodeRole) -> Self {
        let name = name.into();
        Self {
            role_label: role.label().to_owned(),
            name,
            role,
            running: role != NodeRole::Offline,
            endpoint: None,
            queues: None,
            leaders: None,
        }
    }

    pub fn with_running(mut self, running: bool) -> Self {
        self.running = running;
        if !running {
            self.role = NodeRole::Offline;
            self.role_label = NodeRole::Offline.label().to_owned();
        }
        self
    }

    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = Some(endpoint.into());
        self
    }

    pub fn with_queues(mut self, queues: u64) -> Self {
        self.queues = Some(queues);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_label_matches_variant() {
        assert_eq!(NodeRole::Disc.label(), "磁盘节点");
        assert_eq!(NodeRole::Ram.label(), "内存节点");
    }

    #[test]
    fn running_false_downgrades_role_to_offline() {
        let node = ClusterNode::new("rabbit@node1", NodeRole::Disc).with_running(false);
        assert!(!node.running);
        assert_eq!(node.role, NodeRole::Offline);
        assert_eq!(node.role_label, "离线");
    }

    #[test]
    fn node_serializes_as_camel_case_and_skips_absent_fields() {
        let node = ClusterNode::new("kafka-1", NodeRole::Member).with_endpoint("10.0.0.1:9092");
        let json = serde_json::to_value(&node).expect("序列化失败");
        assert_eq!(json["roleLabel"], "成员");
        assert_eq!(json["endpoint"], "10.0.0.1:9092");
        assert!(json.get("queues").is_none());
    }

    #[test]
    fn of_running_keeps_role_when_running() {
        assert_eq!(NodeRole::of_running(true, NodeRole::Ram), NodeRole::Ram);
        assert_eq!(
            NodeRole::of_running(false, NodeRole::Ram),
            NodeRole::Offline
        );
    }
}
