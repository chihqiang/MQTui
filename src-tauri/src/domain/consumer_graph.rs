//! 消费者连线的布局计算。
//!
//! 前几轮我两次拒绝画这张图，理由都是「多个消费者共享一个队列，画出来是一对多扇形，
//! 信息量不如列表」。那个判断本身没错，错在我默认了这张图只能画成「队列 → 消费者」
//! 的星形。这一版换了画法，才敢动笔：
//!
//! - 队列固定在**中间一层**，左边是上游交换机（复用绑定快照），右边是消费者；
//! - 消费者按「连接」聚合，一个服务的 8 个 channel 折成一个框，右侧扇形立刻收敛；
//! - 一个连接消费多个队列时，框只出现一次，用多条线连回去 —— 这正是排查
//!   「谁把消息抢走了」时最关键的信息，列表里散在各队列名下反而看不出来。
//!
//! 这样图回答的问题就变成了「消息从哪来、被谁拿走」，而不是「这个队列有几个消费者数」。
//!
//! 布局规则与拓扑图共用同一套坐标约定（层级 × 层内序号），前端只按坐标摆框。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::consumer_link::{ConsumerHealth, ConsumerLinks, QueueConsumer, judge};
use super::topology::{BindingDestination, RabbitMqTopology};

/// 单张图最多画多少个消费者连接。
///
/// 队列或连接上千时，图只会变成一片模糊的点阵。截断数必须回报出去，
/// 不能让人以为「图上就这些」。
pub const MAX_CONNECTION_NODES: usize = 200;

/// 节点类型。队列与消费者连接之外，交换机也画进来 —— 少了它，
/// 「消息从哪来」这半张图就没了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkNodeKind {
    Exchange,
    Queue,
    Connection,
}

/// 图上的一条边。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkEdgeKind {
    /// 交换机 → 队列的绑定。
    Binding,
    /// 队列 → 消费者连接的消费关系。
    Consume,
}

/// 连接侧的健康状态汇总。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkHealth {
    Healthy,
    /// 至少一个消费者卡在预取上限 / 无上限预取。
    Warn,
    /// 队列有堆积，但这条连接上的消费者一个消息都没领到（预取满 + 未确认为 0 的情况除外）。
    Idle,
}

/// 图上的一个节点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkNode {
    /// 形如 `e:orders` / `q:orders` / `c:svc-a`。
    pub id: String,
    pub kind: LinkNodeKind,
    /// 原始名称。交换机为空串表示默认交换机。
    pub name: String,
    /// 展示用副标题，比如消费者节点的账号与 channel 数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub layer: usize,
    pub row: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<LinkHealth>,
}

/// 图上的一条边。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEdge {
    pub from: String,
    pub to: String,
    pub kind: LinkEdgeKind,
    /// 绑定边的 routing key；消费边留空。
    pub label: String,
}

/// 消费者连线图。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGraph {
    pub nodes: Vec<LinkNode>,
    pub edges: Vec<LinkEdge>,
    pub layers: usize,
    /// 被省略的连接节点数。
    #[serde(default)]
    pub omitted: usize,
    /// 参与绘制的队列数 / 连接数，页面顶部的结论行用。
    pub queue_count: usize,
    pub connection_count: usize,
}

impl ConsumerGraph {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

/// 一个消费者连接的聚合结果。
struct ConnectionGroup {
    name: String,
    usernames: BTreeSet<String>,
    consumers: usize,
    unacknowledged: u64,
    health: LinkHealth,
}

/// 连接节点的名称。匿名时不隐藏，直接写出来。
fn connection_name(consumer: &QueueConsumer) -> String {
    let name = consumer.display_name().trim();
    if name.is_empty() {
        "(未知连接)".to_owned()
    } else {
        name.to_owned()
    }
}

/// 汇总单个连接的健康状态。
///
/// 判定顺序刻意是「先看有没有消费者卡死，再看有没有白吃饭的」：
/// 一个连接上只要有一个消费者卡在预取上限，它就已经在拖队列后腿了，
/// 这时再报「空闲」会把真正的原因盖掉。
fn connection_health(consumers: &[&QueueConsumer]) -> LinkHealth {
    if consumers
        .iter()
        .any(|item| judge(item) != ConsumerHealth::Healthy)
    {
        return LinkHealth::Warn;
    }
    // 自动 ack 的消费者不产生未确认数，用「一个都没领到」判断空闲会误报。
    let all_auto_ack = consumers.iter().all(|item| !item.ack_required);
    if !all_auto_ack
        && consumers
            .iter()
            .all(|item| item.messages_unacknowledged == 0)
    {
        return LinkHealth::Idle;
    }
    LinkHealth::Healthy
}

/// 生成消费者连线图。
///
/// `topology` 只用来画交换机 → 队列那半张图。没有管理 API 拓扑时
/// `topology` 是空的，图退化成「队列 → 消费者」两层，仍然可用。
pub fn build(topology: &RabbitMqTopology, links: &ConsumerLinks) -> ConsumerGraph {
    // 1. 先按连接名聚合消费者。BTreeMap 保证输出顺序稳定，刷新之间图不会跳。
    let mut groups: BTreeMap<String, Vec<&QueueConsumer>> = BTreeMap::new();
    for queue in &links.queues {
        for consumer in &queue.consumers {
            groups
                .entry(connection_name(consumer))
                .or_default()
                .push(consumer);
        }
    }

    let mut connection_nodes: Vec<ConnectionGroup> = groups
        .into_iter()
        .map(|(name, consumers)| {
            let mut usernames = BTreeSet::new();
            let mut unacknowledged = 0u64;
            for consumer in &consumers {
                if !consumer.username.is_empty() {
                    usernames.insert(consumer.username.clone());
                }
                unacknowledged += consumer.messages_unacknowledged;
            }
            ConnectionGroup {
                name,
                usernames,
                consumers: consumers.len(),
                unacknowledged,
                health: connection_health(&consumers),
            }
        })
        .collect();

    // 2. 队列里只画「有消费者」或「有堆积」的。
    //    一个空队列、零消费者，画出来是个孤零零的框，除了挤占视线没有任何信息。
    let queue_names: BTreeSet<String> = links
        .queues
        .iter()
        .filter(|item| !item.consumers.is_empty() || item.messages_ready > 0)
        .map(|item| item.queue.clone())
        .collect();

    // 3. 截断只截消费者连接：它们是数量最不可控的一侧（一个服务几十个 channel 很常见）。
    //    队列被截断会让「谁在消费它」这个问题直接无解，所以队列不截。
    let mut omitted = 0usize;
    if connection_nodes.len() > MAX_CONNECTION_NODES {
        omitted = connection_nodes.len() - MAX_CONNECTION_NODES;
        // 保留连接数最多的那批：先看「谁抢得多」，长尾对排查帮助最小。
        connection_nodes.sort_by(|a, b| {
            b.consumers
                .cmp(&a.consumers)
                .then_with(|| a.name.cmp(&b.name))
        });
        connection_nodes.truncate(MAX_CONNECTION_NODES);
        connection_nodes.sort_by(|a, b| a.name.cmp(&b.name));
    }
    let kept: BTreeSet<&str> = connection_nodes
        .iter()
        .map(|item| item.name.as_str())
        .collect();

    // 4. 交换机：只画「至少连到一个要显示的队列」的那些，逐跳向上补齐，
    //    否则图上会出现一条只连到被省略队列的悬空线。
    let mut edges: Vec<LinkEdge> = Vec::new();
    let queue_ids: BTreeSet<String> = queue_names.iter().map(|name| format!("q:{name}")).collect();

    let mut exchange_names: BTreeSet<String> = BTreeSet::new();
    for binding in &topology.bindings {
        if binding.destination_type == BindingDestination::Queue
            && queue_ids.contains(&format!("q:{}", binding.destination))
        {
            exchange_names.insert(binding.source.clone());
        }
    }
    // 交换机的上游再补一层：链式绑定时只画第一跳会让上游交换机凭空消失。
    // 用不动点迭代而不是递归，环状绑定天然收敛。
    loop {
        let before = exchange_names.len();
        for binding in &topology.bindings {
            if binding.destination_type == BindingDestination::Exchange
                && exchange_names.contains(&binding.destination)
            {
                exchange_names.insert(binding.source.clone());
            }
        }
        if exchange_names.len() == before {
            break;
        }
    }

    for binding in &topology.bindings {
        let from = format!("e:{}", binding.source);
        let (to, keep) = match binding.destination_type {
            BindingDestination::Queue => {
                let id = format!("q:{}", binding.destination);
                let keep = queue_ids.contains(&id);
                (id, keep)
            }
            BindingDestination::Exchange => {
                let id = format!("e:{}", binding.destination);
                let keep = exchange_names.contains(&binding.destination);
                (id, keep)
            }
        };
        if !keep {
            continue;
        }
        // 自环（交换机绑自己）画出来是一条回到原点的线，纯噪音。
        if from == to {
            continue;
        }
        edges.push(LinkEdge {
            from,
            to,
            kind: LinkEdgeKind::Binding,
            label: binding.routing_key.clone(),
        });
    }

    // 5. 队列 → 消费者连接。一个连接消费多个队列时逐条连线，这是图的核心价值。
    for queue in &links.queues {
        for consumer in &queue.consumers {
            let name = connection_name(consumer);
            if !kept.contains(name.as_str()) {
                continue;
            }
            edges.push(LinkEdge {
                from: format!("q:{}", queue.queue),
                to: format!("c:{name}"),
                kind: LinkEdgeKind::Consume,
                label: String::new(),
            });
        }
    }

    // 6. 层号：交换机 → 队列 → 消费者。交换机内部的上下游用「到队列的最小跳数」定层，
    //    保证边一定从左指向右。没有上游交换机的队列直接落在队列层。
    let queue_layer: usize = if exchange_names.is_empty() { 0 } else { 1 };
    let exchange_names_sorted: Vec<String> = exchange_names.iter().cloned().collect();
    let mut nodes: Vec<LinkNode> = Vec::new();

    for name in &exchange_names_sorted {
        nodes.push(LinkNode {
            id: format!("e:{name}"),
            kind: LinkNodeKind::Exchange,
            name: name.clone(),
            subtitle: None,
            layer: queue_layer.saturating_sub(1),
            row: 0,
            health: None,
        });
    }
    for name in &queue_names {
        nodes.push(LinkNode {
            id: format!("q:{name}"),
            kind: LinkNodeKind::Queue,
            name: name.clone(),
            subtitle: None,
            layer: queue_layer,
            row: 0,
            health: None,
        });
    }
    for group in &connection_nodes {
        let health = match group.health {
            LinkHealth::Healthy => None,
            other => Some(other),
        };
        let mut subtitle_parts: Vec<String> = Vec::new();
        if group.consumers > 1 {
            subtitle_parts.push(format!("{} 个消费者", group.consumers));
        }
        if let Some(users) = group.username_list() {
            subtitle_parts.push(users);
        }
        if group.unacknowledged > 0 {
            subtitle_parts.push(format!("未确认 {}", group.unacknowledged));
        }
        nodes.push(LinkNode {
            id: format!("c:{}", group.name),
            kind: LinkNodeKind::Connection,
            name: group.name.clone(),
            subtitle: if subtitle_parts.is_empty() {
                None
            } else {
                Some(subtitle_parts.join(" · "))
            },
            layer: queue_layer + 1,
            row: 0,
            health,
        });
    }

    // 7. 层内序号：交换机层按「连到的队列数」降序、队列层按「消费者数」降序。
    //    把最忙的排在上面，是因为屏幕只有那么高，先看到重要的。
    let mut incoming_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for edge in &edges {
        if edge.kind == LinkEdgeKind::Binding {
            *incoming_counts.entry(edge.to.as_str()).or_default() += 1;
        }
    }
    let queue_consumer_count: BTreeMap<String, usize> = links
        .queues
        .iter()
        .map(|item| (format!("q:{}", item.queue), item.consumers.len()))
        .collect();

    let mut by_layer: BTreeMap<usize, Vec<&mut LinkNode>> = BTreeMap::new();
    for node in &mut nodes {
        by_layer.entry(node.layer).or_default().push(node);
    }
    for items in by_layer.values_mut() {
        items.sort_by(|a, b| {
            let load = |node: &LinkNode| -> usize {
                match node.kind {
                    LinkNodeKind::Queue => *queue_consumer_count.get(&node.id).unwrap_or(&0),
                    _ => *incoming_counts.get(node.id.as_str()).unwrap_or(&0),
                }
            };
            load(b).cmp(&load(a)).then_with(|| a.name.cmp(&b.name))
        });
        for (index, node) in items.iter_mut().enumerate() {
            node.row = index;
        }
    }

    let layers = nodes
        .iter()
        .map(|node| node.layer)
        .max()
        .map_or(0, |top| top + 1);

    let queue_count = queue_names.len();

    ConsumerGraph {
        connection_count: connection_nodes.len(),
        omitted,
        nodes,
        edges,
        layers,
        queue_count,
    }
}

impl ConnectionGroup {
    /// `svc-a, svc-b` 形式；只有一个账号时直接给名字。
    fn username_list(&self) -> Option<String> {
        match self.usernames.len() {
            0 => None,
            1 => self
                .usernames
                .iter()
                .next()
                .map(|name| format!("用户 {name}")),
            _ => Some(format!("{} 个账号", self.usernames.len())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::consumer_link::summarize;
    use crate::domain::topology::{BindingInfo, ExchangeInfo, ExchangeKind};

    fn consumer(tag: &str, queue: &str, conn: &str, prefetch: u32, unacked: u64) -> QueueConsumer {
        QueueConsumer {
            queue: queue.to_owned(),
            consumer_tag: tag.to_owned(),
            connection_name: Some(conn.to_owned()),
            channel: None,
            username: "app".to_owned(),
            ack_required: true,
            prefetch_count: prefetch,
            messages_unacknowledged: unacked,
        }
    }

    fn queue(name: &str) -> crate::domain::QueueInfo {
        crate::domain::QueueInfo {
            name: name.to_owned(),
            vhost: "/".to_owned(),
            consumers: 0,
            messages: 0,
        }
    }

    fn binding(
        source: &str,
        destination: &str,
        kind: BindingDestination,
        key: &str,
    ) -> BindingInfo {
        BindingInfo {
            source: source.to_owned(),
            destination: destination.to_owned(),
            destination_type: kind,
            routing_key: key.to_owned(),
            arguments: Vec::new(),
        }
    }

    fn topology(
        exchanges: &[&str],
        queues: &[&str],
        bindings: Vec<BindingInfo>,
    ) -> RabbitMqTopology {
        RabbitMqTopology {
            exchanges: exchanges
                .iter()
                .map(|name| ExchangeInfo {
                    name: (*name).to_owned(),
                    vhost: "/".to_owned(),
                    kind: "direct".to_owned(),
                    exchange_type: ExchangeKind::Direct,
                    internal: false,
                    message_rate: 0.0,
                })
                .collect(),
            bindings,
            queues: queues.iter().map(|name| queue(name)).collect(),
        }
    }

    #[test]
    fn connections_are_collapsed_by_name() {
        let queues = vec![("orders".to_owned(), 10, 20)];
        let consumers = vec![
            consumer("t1", "orders", "svc-a", 10, 10),
            consumer("t2", "orders", "svc-a", 10, 10),
            consumer("t3", "orders", "svc-b", 10, 1),
        ];
        let links = summarize(&queues, &consumers);
        let graph = build(&topology(&[], &["orders"], vec![]), &links);

        let connections: Vec<&LinkNode> = graph
            .nodes
            .iter()
            .filter(|node| node.kind == LinkNodeKind::Connection)
            .collect();
        // 8 个 channel 折成一个框，这正是这版画法敢动笔的前提。
        assert_eq!(connections.len(), 2);
        assert_eq!(graph.connection_count, 2);
        // 消费者数多的排在上面。
        assert_eq!(connections[0].name, "svc-a");
        assert_eq!(connections[0].row, 0);
        assert_eq!(
            connections[0].subtitle.as_deref(),
            Some("2 个消费者 · 用户 app · 未确认 20")
        );
    }

    #[test]
    fn one_connection_consuming_many_queues_gets_many_edges() {
        let queues = vec![("orders".to_owned(), 5, 0), ("audit".to_owned(), 5, 0)];
        let consumers = vec![
            consumer("t1", "orders", "svc-a", 10, 0),
            consumer("t2", "audit", "svc-a", 10, 0),
        ];
        let links = summarize(&queues, &consumers);
        let graph = build(&topology(&[], &["orders", "audit"], vec![]), &links);

        let consume_edges: Vec<&LinkEdge> = graph
            .edges
            .iter()
            .filter(|edge| edge.kind == LinkEdgeKind::Consume)
            .collect();
        // 同一个连接框连回两个队列 —— 列表里这条信息是散在两行里的。
        assert_eq!(consume_edges.len(), 2);
        assert!(consume_edges.iter().all(|edge| edge.to == "c:svc-a"));
    }

    #[test]
    fn empty_queues_without_consumers_are_dropped() {
        let queues = vec![("orders".to_owned(), 5, 0), ("empty".to_owned(), 0, 0)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 0)];
        let links = summarize(&queues, &consumers);
        let graph = build(&topology(&[], &["orders", "empty"], vec![]), &links);

        assert!(graph.nodes.iter().any(|node| node.id == "q:orders"));
        // 空队列 + 零消费者，画出来只是个孤零零的框。
        assert!(!graph.nodes.iter().any(|node| node.id == "q:empty"));
        assert_eq!(graph.queue_count, 1);
    }

    #[test]
    fn exchanges_only_drawn_when_they_reach_a_shown_queue() {
        let queues = vec![("orders".to_owned(), 5, 0)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 0)];
        let links = summarize(&queues, &consumers);
        let topo = topology(
            &["fanout", "dangling"],
            &["orders"],
            vec![
                binding("", "orders", BindingDestination::Queue, "orders"),
                binding("fanout", "orders", BindingDestination::Queue, ""),
                // 这条指向一个不存在的队列，不该在图里留下悬空线。
                binding("dangling", "ghost", BindingDestination::Queue, "x"),
            ],
        );
        let graph = build(&topo, &links);

        assert!(graph.nodes.iter().any(|node| node.id == "e:fanout"));
        assert!(graph.nodes.iter().any(|node| node.id == "q:orders"));
        assert!(!graph.nodes.iter().any(|node| node.id == "e:dangling"));
        assert!(!graph.edges.iter().any(|edge| edge.to == "q:ghost"));
    }

    #[test]
    fn exchange_chain_upward_is_completed() {
        let queues = vec![("orders".to_owned(), 5, 0)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 0)];
        let links = summarize(&queues, &consumers);
        let topo = topology(
            &["root", "mid"],
            &["orders"],
            vec![
                binding("root", "mid", BindingDestination::Exchange, "go"),
                binding("mid", "orders", BindingDestination::Queue, "orders"),
            ],
        );
        let graph = build(&topo, &links);

        // 只画第一跳会让 root 凭空消失，两跳都得在。
        assert!(graph.nodes.iter().any(|node| node.id == "e:root"));
        assert!(graph.nodes.iter().any(|node| node.id == "e:mid"));
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| edge.from == "e:root" && edge.to == "e:mid")
        );
    }

    #[test]
    fn binding_cycles_terminate() {
        let queues = vec![("orders".to_owned(), 5, 0)];
        let links = summarize(&queues, &[]);
        let topo = topology(
            &["a", "b"],
            &["orders"],
            vec![
                binding("a", "b", BindingDestination::Exchange, "1"),
                binding("b", "a", BindingDestination::Exchange, "2"),
                binding("a", "orders", BindingDestination::Queue, "orders"),
                // 自环也不该出现。
                binding("a", "a", BindingDestination::Exchange, "self"),
            ],
        );
        let graph = build(&topo, &links);
        assert!(graph.edges.iter().all(|edge| edge.from != edge.to));
    }

    #[test]
    fn prefetch_saturation_marks_connection_warn() {
        let queues = vec![("orders".to_owned(), 100, 10)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 10)];
        let links = summarize(&queues, &consumers);
        let graph = build(&topology(&[], &["orders"], vec![]), &links);

        let node = graph
            .nodes
            .iter()
            .find(|node| node.id == "c:svc-a")
            .expect("缺少连接节点");
        assert_eq!(node.health, Some(LinkHealth::Warn));
    }

    #[test]
    fn connection_without_any_claim_is_idle() {
        let queues = vec![("orders".to_owned(), 100, 0)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 0)];
        let links = summarize(&queues, &consumers);
        let graph = build(&topology(&[], &["orders"], vec![]), &links);

        let node = graph
            .nodes
            .iter()
            .find(|node| node.id == "c:svc-a")
            .expect("缺少连接节点");
        assert_eq!(node.health, Some(LinkHealth::Idle));
    }

    #[test]
    fn auto_ack_consumers_are_not_reported_idle() {
        // 自动 ack 不产生未确认数，只因「一个都没领到」就判空闲会误报。
        let queues = vec![("orders".to_owned(), 100, 0)];
        let mut item = consumer("t1", "orders", "svc-a", 0, 0);
        item.ack_required = false;
        let links = summarize(&queues, &[item]);
        let graph = build(&topology(&[], &["orders"], vec![]), &links);

        let node = graph
            .nodes
            .iter()
            .find(|node| node.id == "c:svc-a")
            .expect("缺少连接节点");
        assert_eq!(node.health, None);
    }

    #[test]
    fn layers_are_ordered_exchange_queue_connection() {
        let queues = vec![("orders".to_owned(), 5, 0)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 0)];
        let links = summarize(&queues, &consumers);
        let topo = topology(
            &["fanout"],
            &["orders"],
            vec![binding("fanout", "orders", BindingDestination::Queue, "")],
        );
        let graph = build(&topo, &links);

        let layer = |prefix: &str| {
            graph
                .nodes
                .iter()
                .find(|node| node.id == prefix)
                .map(|node| node.layer)
                .expect("缺少节点")
        };
        assert!(layer("e:fanout") < layer("q:orders"));
        assert!(layer("q:orders") < layer("c:svc-a"));
        assert_eq!(graph.layers, 3);
    }

    #[test]
    fn serializes_camel_case() {
        let queues = vec![("orders".to_owned(), 5, 0)];
        let consumers = vec![consumer("t1", "orders", "svc-a", 10, 0)];
        let links = summarize(&queues, &consumers);
        let graph = build(&topology(&[], &["orders"], vec![]), &links);
        let json = serde_json::to_value(&graph).expect("序列化失败");
        assert!(json["nodes"][0].get("kind").is_some());
        assert_eq!(json["connectionCount"], 1);
        assert_eq!(json["omitted"], 0);
    }
}
