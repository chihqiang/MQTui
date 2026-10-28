//! RabbitMQ 运行时数据：节点、连接、通道、队列位置。
//!
//! 与 `management.rs` 的分工：那边负责「发请求 + 解析管理 API 的字段」，
//! 这边负责「把几次请求拼成一张能读的表」。分开的理由很实际 ——
//! 前者的改动节奏跟着 RabbitMQ 版本走，后者跟着排查需求走。
//!
//! 失败的取舍：节点指标在各版本管理 API 上字段差异最大（老版本不报 `mem_limit`），
//! 所以节点列表取不到时返回空列表而不是让整页报错 ——
//! 连接和队列位置仍然是有用的信息，不该被一次失败的请求连坐。

use serde::Deserialize;

use crate::domain::{ChannelRow, ClusterNode, ConnectionRow, NodeRole, NodeStat, QueuePlacement};
use crate::error::AppResult;

use super::client::RabbitMqClient;
use super::management::{ManagementClient, percent_encode};

/// `GET /api/nodes` 的一行，只取面板要用的字段。
#[derive(Debug, Deserialize)]
struct NodePayload {
    name: String,
    #[serde(default)]
    running: bool,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    mem_used: u64,
    #[serde(default)]
    mem_limit: u64,
    #[serde(default)]
    disk_free: u64,
    #[serde(default)]
    disk_free_limit: u64,
    #[serde(default)]
    fd_used: u64,
    #[serde(default)]
    fd_total: u64,
    #[serde(default)]
    sockets_used: u64,
    #[serde(default)]
    sockets_total: u64,
    #[serde(default)]
    proc_used: u64,
    #[serde(default)]
    proc_total: u64,
    /// 告警列表。非空即表示该节点当前处于水位告警中。
    #[serde(default)]
    alarms: Vec<serde_json::Value>,
}

/// `GET /api/queues` 里位置相关的字段。
#[derive(Debug, Deserialize)]
struct PlacementPayload {
    name: String,
    #[serde(default)]
    vhost: String,
    #[serde(default)]
    node: Option<String>,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    durable: bool,
    #[serde(default)]
    exclusive: bool,
    /// 仲裁队列的成员节点。
    #[serde(default)]
    members: Vec<String>,
    /// 经典镜像队列的副本节点。
    #[serde(default)]
    slave_nodes: Vec<String>,
}

/// `GET /api/connections` 的一行。
#[derive(Debug, Deserialize)]
struct ConnPayload {
    name: String,
    #[serde(default)]
    client_properties: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    peer_host: String,
    #[serde(default)]
    peer_port: u16,
    #[serde(default)]
    channels: u32,
    #[serde(default)]
    state: String,
    #[serde(default)]
    recv_oct_details: Option<RateDetail>,
    #[serde(default)]
    send_oct_details: Option<RateDetail>,
}

#[derive(Debug, Deserialize)]
struct RateDetail {
    #[serde(default)]
    rate: f64,
}

/// `GET /api/channels` 的一行。
#[derive(Debug, Deserialize)]
struct ChanPayload {
    name: String,
    #[serde(default)]
    connection_details: Option<ConnRef>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    consumer_count: u32,
    #[serde(default)]
    prefetch_count: u32,
    #[serde(default)]
    messages_unacknowledged: u64,
    #[serde(default)]
    acks: u64,
}

#[derive(Debug, Deserialize)]
struct ConnRef {
    #[serde(default)]
    name: String,
}

/// 管理 API 的节点类型只有 `disc` / `ram`。
///
/// 控制节点（controller）在 RabbitMQ 里是另一个概念且版本间字段不一致，
/// 这里不猜：猜错会让「控制节点」这一行指向错误的机器。
fn role_of(kind: &str) -> NodeRole {
    match kind {
        "ram" => NodeRole::Ram,
        _ => NodeRole::Disc,
    }
}

/// 客户端连接名藏在 `client_properties.connection_name` 里，取不到就留空。
pub(super) fn client_name(properties: &serde_json::Map<String, serde_json::Value>) -> String {
    properties
        .get("connection_name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_owned()
}

impl RabbitMqClient {
    /// 节点运行时指标。取不到时返回空列表，由上层展示「指标不可用」。
    pub async fn nodes(&self) -> AppResult<Vec<NodeStat>> {
        let management = self.management()?;
        let payload: Vec<NodePayload> = management.nodes_payload(self).await?;

        Ok(payload
            .into_iter()
            .map(|node| NodeStat {
                name: node.name,
                running: node.running,
                mem_used: node.mem_used,
                mem_limit: node.mem_limit,
                disk_free: node.disk_free,
                disk_limit: node.disk_free_limit,
                fd_used: node.fd_used,
                fd_total: node.fd_total,
                sockets_used: node.sockets_used,
                sockets_total: node.sockets_total,
                proc_used: node.proc_used,
                proc_total: node.proc_total,
                alarm: !node.alarms.is_empty(),
            })
            .collect())
    }

    /// 节点列表转成集群页的通用节点结构（与 Kafka 集群页共用同一套展示模型）。
    pub async fn cluster_nodes(&self) -> AppResult<Vec<ClusterNode>> {
        let management = self.management()?;
        let payload: Vec<NodePayload> = management.nodes_payload(self).await?;

        let mut nodes: Vec<ClusterNode> = payload
            .into_iter()
            .map(|node| {
                let mut item = ClusterNode::new(node.name.clone(), role_of(&node.kind))
                    .with_running(node.running);
                // 节点名形如 `rabbit@host`，`@` 后面那截才是能直连的主机名。
                if let Some((_, host)) = node.name.split_once('@') {
                    item = item.with_endpoint(host);
                }
                item
            })
            .collect();
        nodes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(nodes)
    }

    /// 队列位置：哪个队列落在哪个节点上。
    pub async fn queue_placements(&self) -> AppResult<Vec<QueuePlacement>> {
        let management = self.management()?;
        let payload: Vec<PlacementPayload> = management.queues_payload(self).await?;

        Ok(payload
            .into_iter()
            .map(|queue| {
                // 位置有三个来源，按「准到不准」取：
                // 主节点 `node` 最准，仲裁队列的 `members` 次之，镜像副本 `slave_nodes` 再次。
                // 重复的节点只留一份 —— 管理 API 偶尔会重复报同一个节点。
                let mut nodes: Vec<String> = Vec::new();
                let candidates = queue
                    .node
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .chain(queue.members)
                    .chain(queue.slave_nodes);
                for candidate in candidates {
                    if !candidate.is_empty() && !nodes.contains(&candidate) {
                        nodes.push(candidate);
                    }
                }

                QueuePlacement {
                    name: queue.name,
                    vhost: queue.vhost,
                    nodes,
                    kind: if queue.kind.is_empty() {
                        "classic".to_owned()
                    } else {
                        queue.kind
                    },
                    durable: queue.durable,
                    exclusive: queue.exclusive,
                }
            })
            .collect())
    }

    /// 套接字连接列表。
    pub async fn connection_rows(&self) -> AppResult<Vec<ConnectionRow>> {
        let management = self.management()?;
        let payload: Vec<ConnPayload> = management.connections_payload(self).await?;

        Ok(payload
            .into_iter()
            .map(|row| ConnectionRow {
                client_name: client_name(&row.client_properties),
                name: row.name,
                user: row.user,
                peer_host: row.peer_host,
                peer_port: row.peer_port,
                channels: row.channels,
                state: row.state,
                recv_rate: row.recv_oct_details.map_or(0.0, |detail| detail.rate),
                send_rate: row.send_oct_details.map_or(0.0, |detail| detail.rate),
            })
            .collect())
    }

    /// 通道列表。
    pub async fn channel_rows(&self) -> AppResult<Vec<ChannelRow>> {
        let management = self.management()?;
        let payload: Vec<ChanPayload> = management.channels_payload(self).await?;

        Ok(payload
            .into_iter()
            .map(|row| ChannelRow {
                name: row.name,
                connection: row
                    .connection_details
                    .map(|details| details.name)
                    .unwrap_or_default(),
                user: row.user,
                consumers: row.consumer_count,
                prefetch: row.prefetch_count,
                unacked: row.messages_unacknowledged,
                acks: row.acks,
            })
            .collect())
    }

    /// 关闭一条 AMQP 连接（`DELETE /api/connections/{name}`）。
    ///
    /// 这是「让对方掉线」的动作：连接上的所有 channel、消费者一起消失，
    /// 正在被处理但未确认的消息会被服务端重新入队。安全性判定放在调用方，
    /// 这里只挡住空名字这种明显错误。
    pub async fn close_connection(&self, name: &str) -> AppResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(crate::error::AppError::Invalid("连接名不能为空".to_owned()));
        }
        self.management()?.close_connection(self, name).await
    }

    /// 关闭一个通道（`DELETE /api/channels/{name}`）。
    pub async fn close_channel(&self, name: &str) -> AppResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(crate::error::AppError::Invalid("通道名不能为空".to_owned()));
        }
        self.management()?.close_channel(self, name).await
    }
}

/// 管理 API 侧的请求封装。
///
/// 放在本模块的 `impl ManagementClient` 里，而不是把 `get_json` 提成 `pub`：
/// 那会让「谁能发请求」在模块外随便可见，调用边界一眼看不出来。
impl ManagementClient {
    pub(super) async fn nodes_payload<T>(&self, client: &RabbitMqClient) -> AppResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        self.get_json(
            "/api/nodes",
            &client.config().auth.username,
            &client.config().auth.password,
        )
        .await
    }

    pub(super) async fn queues_payload<T>(&self, client: &RabbitMqClient) -> AppResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let config = client.config();
        self.get_json(
            &self.vhost_path("/api/queues", &config.auth.vhost),
            &config.auth.username,
            &config.auth.password,
        )
        .await
    }

    pub(super) async fn connections_payload<T>(&self, client: &RabbitMqClient) -> AppResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let config = client.config();
        self.get_json(
            &self.vhost_path("/api/connections", &config.auth.vhost),
            &config.auth.username,
            &config.auth.password,
        )
        .await
    }

    pub(super) async fn channels_payload<T>(&self, client: &RabbitMqClient) -> AppResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let config = client.config();
        self.get_json(
            &self.vhost_path("/api/channels", &config.auth.vhost),
            &config.auth.username,
            &config.auth.password,
        )
        .await
    }

    /// 关闭连接。名字在路径里，需要百分号编码。
    pub(super) async fn close_connection(
        &self,
        client: &RabbitMqClient,
        name: &str,
    ) -> AppResult<()> {
        let config = client.config();
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/connections", &config.auth.vhost),
            percent_encode(name)
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }

    /// 关闭通道。
    pub(super) async fn close_channel(&self, client: &RabbitMqClient, name: &str) -> AppResult<()> {
        let config = client.config();
        let path = format!(
            "{}/{}",
            self.vhost_path("/api/channels", &config.auth.vhost),
            percent_encode(name)
        );
        self.delete(&path, &config.auth.username, &config.auth.password)
            .await
    }
}
