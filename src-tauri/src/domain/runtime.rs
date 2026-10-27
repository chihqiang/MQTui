//! RabbitMQ 运行时状态：连接、通道与队列位置的领域模型。
//!
//! 排查「消息到底被谁拿走了」时，队列列表和消费者列表都不够用：
//! - 一个 TCP 连接上可能开着几十个 channel，某个 channel 卡住整条连接都会受影响；
//! - 队列在哪个节点上，决定了某个节点挂掉时哪些队列跟着不可用。
//!
//! 这两件事都要从管理 API 的 `/api/connections`、`/api/channels`、`/api/queues` 里读，
//! 但原始结构极其扁平（每个 channel 一行、每个连接一行），
//! 直接摊给界面就是三张互相对不上号的表。所以这里做一次聚合与判读，
//! 规则全是纯函数，可以脱库单测。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// 一条 AMQP 连接（管理 API 的 `GET /api/connections`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRow {
    pub name: String,
    /// 客户端上报的连接名，排查时比服务端生成的 name 有用得多。
    pub client_name: String,
    pub user: String,
    pub peer_host: String,
    pub peer_port: u16,
    /// 已打开的 channel 数。
    pub channels: u32,
    pub state: String,
    /// 每秒收发字节数（取管理 API 的 `recv_oct_details.rate` / `send_oct_details.rate`）。
    pub recv_rate: f64,
    pub send_rate: f64,
}

impl ConnectionRow {
    /// 连接是否处于阻塞状态（`blocked` / `blocking`）。
    ///
    /// RabbitMQ 的内存 / 磁盘水位触发阻塞时，连接会停在 `blocking`，
    /// 发布方看起来「发出去了但没反应」——这是最常见的假死表现，必须显式标出来。
    pub fn is_blocked(&self) -> bool {
        matches!(self.state.as_str(), "blocking" | "blocked")
    }

    /// 连接是否还活着。`running` 之外的取值都当作已断。
    pub fn is_running(&self) -> bool {
        self.state == "running"
    }
}

/// 一个 channel（管理 API 的 `GET /api/channels`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRow {
    pub name: String,
    /// 所属连接的 name，用来把 channel 挂回连接下面。
    pub connection: String,
    pub user: String,
    /// channel 上的消费者数。
    pub consumers: u32,
    /// 预取上限，0 表示不限。
    pub prefetch: u32,
    /// 已投递但未确认的消息数。
    pub unacked: u64,
    /// 已确认的消息数，用来区分「这个 channel 干过活」和「只是开着」。
    pub acks: u64,
}

impl ChannelRow {
    /// 预取已经打满：手动 ack 且未确认数触到上限，本地缓冲塞满、不再接新消息。
    ///
    /// 自动 ack 的 channel（预取字段为 0 且没有未确认堆积）不判 —— 那种情况下
    /// 没有「塞满」这回事。
    pub fn is_saturated(&self) -> bool {
        self.prefetch > 0 && self.unacked >= u64::from(self.prefetch)
    }

    /// 空转：开着 channel、既没有消费者也没有确认过任何消息。
    pub fn is_idle(&self) -> bool {
        self.consumers == 0 && self.acks == 0 && self.unacked == 0
    }
}

/// 队列在集群中的位置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePlacement {
    pub name: String,
    pub vhost: String,
    /// 承载该队列的节点名。经典队列只有一个，仲裁队列会列出全部成员。
    pub nodes: Vec<String>,
    /// 队列类型（`classic` / `quorum` / `stream`），由管理 API 的 `type` 字段给出。
    pub kind: String,
    pub durable: bool,
    /// 队列是否为「独占队列」（`exclusive`），这种队列只属于声明它的连接。
    pub exclusive: bool,
}

impl QueuePlacement {
    /// 主节点名。经典队列取第一个，仲裁队列的第一个是 leader。
    pub fn primary(&self) -> Option<&str> {
        self.nodes.first().map(String::as_str)
    }

    /// 没有分配节点的队列 = 当前不可用（节点下线后队列会变成这样）。
    pub fn is_unassigned(&self) -> bool {
        self.nodes.is_empty()
    }

    /// 仲裁队列：有副本冗余，节点挂一个不影响可用性。
    pub fn is_replicated(&self) -> bool {
        self.kind == "quorum"
    }
}

/// 连接的聚合视图：一条连接 + 它下面的 channel。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDetail {
    pub connection: ConnectionRow,
    pub channels: Vec<ChannelRow>,
    /// 该连接上所有 channel 的未确认消息合计。
    pub unacked_total: u64,
    /// 预取打满的 channel 数。
    pub saturated: usize,
}

impl ConnectionDetail {
    /// 这条连接上有没有「卡住」的 channel。
    ///
    /// 一条连接里只要有一个 channel 预取打满，该连接上的其它消费者也会被拖慢
    /// —— AMQP 的流控是连接级的。所以这个判定要挂在连接上，而不是只挂在 channel 上。
    pub fn is_stuck(&self) -> bool {
        self.saturated > 0 || self.connection.is_blocked()
    }
}

/// 一次运行时的完整快照。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub connections: Vec<ConnectionDetail>,
    pub queues: Vec<QueuePlacement>,
    /// 没有分配节点的队列名：这些队列当前不可用。
    pub unassigned: Vec<String>,
    /// 按节点聚合的队列数，回答「这个节点上压了多少队列」。
    pub per_node: BTreeMap<String, usize>,
}

/// 把扁平的连接与 channel 列表聚合成连接详情。
///
/// 两条规则：
/// - channel 的 `connection` 字段是唯一归属依据；对不上任何连接的 channel 直接丢弃
///   （通常是从列表拉取到现在这一刻刚好断开的残留）
/// - 输出按连接名排序，界面不会因为管理 API 返回顺序抖动而整表跳动
pub fn assemble(connections: &[ConnectionRow], channels: &[ChannelRow]) -> Vec<ConnectionDetail> {
    let mut grouped: BTreeMap<&str, Vec<ChannelRow>> = BTreeMap::new();
    for channel in channels {
        grouped
            .entry(channel.connection.as_str())
            .or_default()
            .push(channel.clone());
    }

    let mut details: Vec<ConnectionDetail> = connections
        .iter()
        .map(|connection| {
            let mut owned = grouped.remove(connection.name.as_str()).unwrap_or_default();
            owned.sort_by(|a, b| a.name.cmp(&b.name));
            ConnectionDetail {
                unacked_total: owned.iter().map(|channel| channel.unacked).sum(),
                saturated: owned
                    .iter()
                    .filter(|channel| channel.is_saturated())
                    .count(),
                connection: connection.clone(),
                channels: owned,
            }
        })
        .collect();

    details.sort_by(|a, b| a.connection.name.cmp(&b.connection.name));
    details
}

/// 汇总队列位置：未分配列表 + 每个节点承载的队列数。
pub fn place_queues(queues: &[QueuePlacement]) -> RuntimeSnapshot {
    let mut per_node: BTreeMap<String, usize> = BTreeMap::new();
    let mut unassigned = Vec::new();

    for queue in queues {
        if queue.is_unassigned() {
            unassigned.push(queue.name.clone());
            continue;
        }
        // 仲裁队列有多个成员节点：每个节点都算承载了它，
        // 因为「节点上有什么」这个问题的答案是「它的副本在这里」。
        for node in queue.nodes.iter().collect::<BTreeSet<_>>() {
            *per_node.entry(node.clone()).or_insert(0) += 1;
        }
    }

    unassigned.sort();
    RuntimeSnapshot {
        connections: Vec::new(),
        queues: queues.to_vec(),
        unassigned,
        per_node,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(name: &str, state: &str) -> ConnectionRow {
        ConnectionRow {
            name: name.to_owned(),
            client_name: String::new(),
            user: "guest".to_owned(),
            peer_host: "127.0.0.1".to_owned(),
            peer_port: 1234,
            channels: 1,
            state: state.to_owned(),
            recv_rate: 0.0,
            send_rate: 0.0,
        }
    }

    fn channel(name: &str, connection: &str, prefetch: u32, unacked: u64) -> ChannelRow {
        ChannelRow {
            name: name.to_owned(),
            connection: connection.to_owned(),
            user: "guest".to_owned(),
            consumers: 1,
            prefetch,
            unacked,
            acks: 1,
        }
    }

    #[test]
    fn channels_are_grouped_under_their_connection() {
        let details = assemble(
            &[connection("c1", "running")],
            &[
                channel("c1-ch2", "c1", 10, 3),
                channel("c1-ch1", "c1", 10, 7),
            ],
        );
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].channels.len(), 2);
        // 同一连接内按 channel 名排序，界面不会因为服务端顺序抖动而跳动。
        assert_eq!(details[0].channels[0].name, "c1-ch1");
        assert_eq!(details[0].unacked_total, 10);
    }

    #[test]
    fn channel_without_matching_connection_is_dropped() {
        let details = assemble(
            &[connection("c1", "running")],
            &[channel("c9-ch1", "c9", 0, 0)],
        );
        assert_eq!(details.len(), 1);
        assert!(details[0].channels.is_empty());
    }

    #[test]
    fn saturated_channel_counts_and_marks_connection_stuck() {
        let details = assemble(
            &[connection("c1", "running")],
            &[channel("c1-ch1", "c1", 5, 5)],
        );
        assert_eq!(details[0].saturated, 1);
        assert!(details[0].is_stuck());
    }

    #[test]
    fn unlimited_prefetch_is_never_saturated() {
        // 预取 0 = 不限，未确认再多也不是「塞满」。
        let row = channel("c1-ch1", "c1", 0, 9999);
        assert!(!row.is_saturated());
    }

    #[test]
    fn blocked_state_is_reported_separately_from_running() {
        let row = connection("c1", "blocking");
        assert!(row.is_blocked());
        assert!(!row.is_running());
    }

    #[test]
    fn idle_channel_has_no_consumers_and_no_traffic() {
        let mut row = channel("c1-ch1", "c1", 0, 0);
        row.consumers = 0;
        row.acks = 0;
        assert!(row.is_idle());
    }

    #[test]
    fn unassigned_queues_are_listed_and_excluded_from_nodes() {
        let snapshot = place_queues(&[
            QueuePlacement {
                name: "orphan".to_owned(),
                vhost: "/".to_owned(),
                nodes: Vec::new(),
                kind: "classic".to_owned(),
                durable: true,
                exclusive: false,
            },
            QueuePlacement {
                name: "orders".to_owned(),
                vhost: "/".to_owned(),
                nodes: vec!["rabbit@n1".to_owned()],
                kind: "classic".to_owned(),
                durable: true,
                exclusive: false,
            },
        ]);
        assert_eq!(snapshot.unassigned, vec!["orphan".to_owned()]);
        assert_eq!(snapshot.per_node.get("rabbit@n1"), Some(&1));
    }

    #[test]
    fn quorum_queue_members_count_on_every_node() {
        let snapshot = place_queues(&[QueuePlacement {
            name: "payments".to_owned(),
            vhost: "/".to_owned(),
            nodes: vec!["rabbit@n1".to_owned(), "rabbit@n2".to_owned()],
            kind: "quorum".to_owned(),
            durable: true,
            exclusive: false,
        }]);
        assert_eq!(snapshot.per_node.len(), 2);
        assert_eq!(snapshot.per_node.get("rabbit@n2"), Some(&1));
    }

    #[test]
    fn repeated_node_in_queue_members_is_counted_once() {
        // 管理 API 偶尔会把同一节点重复列进 members，重复计数会让「节点上多少队列」虚高。
        let snapshot = place_queues(&[QueuePlacement {
            name: "stream".to_owned(),
            vhost: "/".to_owned(),
            nodes: vec!["rabbit@n1".to_owned(), "rabbit@n1".to_owned()],
            kind: "quorum".to_owned(),
            durable: true,
            exclusive: false,
        }]);
        assert_eq!(snapshot.per_node.get("rabbit@n1"), Some(&1));
    }

    #[test]
    fn empty_snapshot_is_all_empty() {
        let snapshot = place_queues(&[]);
        assert!(snapshot.unassigned.is_empty());
        assert!(snapshot.per_node.is_empty());
    }
}
