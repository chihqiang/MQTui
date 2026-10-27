//! RabbitMQ 拓扑图的布局计算。
//!
//! 为什么现在才画图：前面几轮我一直说「多个消费者共享一个队列，画出来是一对多扇形，
//! 信息量不如列表」——这个判断针对的是**消费者连线**，到现在也算数。但交换机与队列之间
//! 的绑定不一样：拓扑是分层的有向图（交换机 → 交换机 → 队列），序列化成一棵树之后
//! 「消息到底走哪条路」不用在两张表之间来回对名字。
//!
//! 布局全部在这里算完，前端只负责按坐标画线和放框：
//! 一个几百个节点的拓扑，布局逻辑放在渲染层就等于把「怎么排」和「怎么画」搅在一起，
//! 而后者的迭代速度远高于前者。这里不碰网络，也不碰 DOM，可以脱库单测。
//!
//! 三条规则值得单独说：
//!
//! 1. **环**：AMQP 允许交换机之间互相绑定。布局必须按「首次出现的层级」截断，
//!    否则一个 `a → b → a` 的环会让递归永远走不完。
//! 2. **同名**：交换机和队列可以同名（很常见，`orders` 既是交换机也是一个队列）。
//!    节点 id 必须带类型前缀，否则图上两个节点会被合并成一个。
//! 3. **默认交换机**：名字是空串，但它经常是绑定最多的那个节点，
//!    直接丢掉会让图看起来「少了一半线」。

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use super::topology::{BindingDestination, BindingInfo, RabbitMqTopology};

/// 单张图最多画多少个节点。
///
/// 超过这个规模的拓扑，画出来已经没人看得清，该去用过滤器而不是继续铺。
/// 截断时必须在结果里说明，不能让用户以为拓扑就这么大。
pub const MAX_NODES: usize = 400;

/// 节点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphNodeKind {
    Exchange,
    Queue,
}

impl GraphNodeKind {
    /// 节点 id 的前缀。交换机和队列可以同名，靠它区分。
    const fn prefix(self) -> &'static str {
        match self {
            Self::Exchange => "e:",
            Self::Queue => "q:",
        }
    }
}

/// 图上的一个节点。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// 唯一标识，形如 `e:orders` / `q:orders`。
    pub id: String,
    pub kind: GraphNodeKind,
    /// 原始名称。默认交换机为空串，前端负责显示成占位文案。
    pub name: String,
    /// 层级：默认交换机与无上游的交换机为第 0 层，逐跳递增。
    pub layer: usize,
    /// 层内序号，已按名称排好序。
    pub row: usize,
    /// 队列的堆积量（管理 API 能提供时才有）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<u64>,
    /// 队列的消费者数量。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumers: Option<u32>,
}

/// 图上的一条边：一条绑定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    /// routing key；空串表示按队列名直投或 fanout。
    pub routing_key: String,
}

/// 拓扑图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// 层级数量，前端据此决定画布高度。
    pub layers: usize,
    /// 被截断的节点数。为 0 表示画的就是全部。
    #[serde(default)]
    pub omitted: usize,
}

impl TopologyGraph {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

/// 节点 id 的构成。同名不同类型不会撞车，这一点必须写死在函数里。
fn node_id(kind: GraphNodeKind, name: &str) -> String {
    format!("{}{}", kind.prefix(), name)
}

/// 生成拓扑图。
///
/// 交换机的层级取「从任一根节点出发的最短路径」：环形绑定下最短路径是唯一
/// 不会绕圈的定义。队列紧挂在它的上游交换机之后。
pub fn build(topology: &RabbitMqTopology) -> TopologyGraph {
    // 交换机名集合：管理 API 上报的 + 绑定表里出现过的。
    // 绑定表可能引用一个已经删掉的交换机，这类节点仍要画出来——它就是「断链」的样子。
    let mut exchange_names: BTreeSet<String> = topology
        .exchanges
        .iter()
        .map(|item| item.name.clone())
        .collect();
    let mut queue_names: BTreeSet<String> = topology
        .queues
        .iter()
        .map(|item| item.name.clone())
        .collect();

    for binding in &topology.bindings {
        exchange_names.insert(binding.source.clone());
        match binding.destination_type {
            BindingDestination::Exchange => {
                exchange_names.insert(binding.destination.clone());
            }
            BindingDestination::Queue => {
                queue_names.insert(binding.destination.clone());
            }
        }
    }

    let layers = assign_layers(&exchange_names, &topology.bindings);

    let mut nodes: Vec<GraphNode> = Vec::new();
    for name in &exchange_names {
        nodes.push(GraphNode {
            id: node_id(GraphNodeKind::Exchange, name),
            kind: GraphNodeKind::Exchange,
            name: name.clone(),
            layer: layers.get(name).copied().unwrap_or(0),
            row: 0,
            messages: None,
            consumers: None,
        });
    }

    let queue_metrics: BTreeMap<&str, (u64, u32)> = topology
        .queues
        .iter()
        .map(|item| (item.name.as_str(), (item.messages, item.consumers)))
        .collect();
    for name in &queue_names {
        // 队列挂在它的上游交换机之后；没有上游时放到最后一层之前，避免压在最上层。
        let layer = upstream_layer(name, &topology.bindings, &layers);
        let metrics = queue_metrics.get(name.as_str()).copied();
        nodes.push(GraphNode {
            id: node_id(GraphNodeKind::Queue, name),
            kind: GraphNodeKind::Queue,
            name: name.clone(),
            layer,
            row: 0,
            messages: metrics.map(|(messages, _)| messages),
            consumers: metrics.map(|(_, consumers)| consumers),
        });
    }

    // 截断：先保留全部交换机（它们承载结构），再按队列名顺序补队列。
    // 顺序必须是确定的，否则每次刷新图的形状都会变。
    let omitted = nodes.len().saturating_sub(MAX_NODES);
    nodes.sort_by(|a, b| {
        a.layer
            .cmp(&b.layer)
            .then(a.kind.cmp(&b.kind))
            .then(a.name.cmp(&b.name))
    });
    nodes.truncate(MAX_NODES);

    let kept: BTreeSet<String> = nodes.iter().map(|node| node.id.clone()).collect();

    // 层内序号：每层按名称排序后编号，前端据此算纵向坐标。
    let mut counters: BTreeMap<usize, usize> = BTreeMap::new();
    for node in &mut nodes {
        let counter = counters.entry(node.layer).or_insert(0);
        node.row = *counter;
        *counter += 1;
    }

    let mut edges: Vec<GraphEdge> = topology
        .bindings
        .iter()
        .filter_map(|binding| {
            let from = node_id(GraphNodeKind::Exchange, &binding.source);
            let to = match binding.destination_type {
                BindingDestination::Exchange => {
                    node_id(GraphNodeKind::Exchange, &binding.destination)
                }
                BindingDestination::Queue => node_id(GraphNodeKind::Queue, &binding.destination),
            };
            // 端点被截断掉的边不画：悬空的线比没有线更让人费解。
            if !kept.contains(&from) || !kept.contains(&to) {
                return None;
            }
            Some(GraphEdge {
                from,
                to,
                routing_key: binding.routing_key.clone(),
            })
        })
        .collect();

    // 边的顺序也要确定：按端口名排序，图才稳定。
    edges.sort_by(|a, b| {
        a.from
            .cmp(&b.from)
            .then(a.to.cmp(&b.to))
            .then(a.routing_key.cmp(&b.routing_key))
    });
    edges.dedup();

    let layer_count = nodes
        .iter()
        .map(|node| node.layer)
        .max()
        .map_or(0, |max| max + 1);

    TopologyGraph {
        nodes,
        edges,
        layers: layer_count,
        omitted,
    }
}

/// 交换机的层级：从根节点（没有入边的交换机）出发做 BFS。
///
/// 环上的交换机永远进不了根集合，所以 BFS 之后再给剩下的节点补一轮：
/// 把还没定层的节点当作新的根，从最小名称开始。这样环里的节点不会全部堆在第 0 层。
fn assign_layers(
    exchanges: &BTreeSet<String>,
    bindings: &[BindingInfo],
) -> BTreeMap<String, usize> {
    let mut incoming: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for name in exchanges {
        incoming.entry(name.as_str()).or_default();
    }
    for binding in bindings {
        if binding.destination_type != BindingDestination::Exchange {
            continue;
        }
        incoming
            .entry(binding.destination.as_str())
            .or_default()
            .push(binding.source.as_str());
    }

    let mut layers: BTreeMap<String, usize> = BTreeMap::new();
    let mut queue: VecDeque<&str> = VecDeque::new();

    // 第一轮：默认交换机（空串）永远是根，它没有上游。
    if exchanges.contains("") {
        layers.insert(String::new(), 0);
        queue.push_back("");
    }
    // 其余没有任何入边的交换机也是一级根。名称排序保证结果稳定。
    for name in exchanges {
        if name.is_empty() || layers.contains_key(name) {
            continue;
        }
        let has_upstream = incoming
            .get(name.as_str())
            .is_some_and(|sources| sources.iter().any(|source| source != name));
        if !has_upstream {
            layers.insert(name.clone(), 0);
            queue.push_back(name);
        }
    }

    while let Some(current) = queue.pop_front() {
        let layer = layers.get(current).copied().unwrap_or(0);
        for binding in bindings {
            if binding.source != current
                || binding.destination_type != BindingDestination::Exchange
                || binding.destination == current
            {
                continue;
            }
            if layers.contains_key(&binding.destination) {
                continue;
            }
            layers.insert(binding.destination.clone(), layer + 1);
            queue.push_back(&binding.destination);
        }
    }

    // 第二轮：环上的节点。按名称顺序把它们当成新的根，只补还没定层的。
    for name in exchanges {
        if layers.contains_key(name) {
            continue;
        }
        let mut cursor: VecDeque<String> = VecDeque::new();
        // 环上的节点没有真正的上游可依，把它们摆在「已有根」的最后一层，
        // 至少不会和真正的根混在一起。
        let base = layers
            .values()
            .filter(|layer| **layer == 0)
            .count()
            .saturating_sub(1);
        layers.insert(name.clone(), base);
        cursor.push_back(name.clone());
        while let Some(current) = cursor.pop_front() {
            let layer = layers.get(&current).copied().unwrap_or(base);
            for binding in bindings {
                if binding.source != current
                    || binding.destination_type != BindingDestination::Exchange
                {
                    continue;
                }
                if layers.contains_key(&binding.destination) {
                    continue;
                }
                layers.insert(binding.destination.clone(), layer + 1);
                cursor.push_back(binding.destination.clone());
            }
        }
    }

    layers
}

/// 队列的层级：所有上游交换机层级的最小值 + 1。
///
/// 取最小值而不是最大值：一个队列如果同时被第 0 层和第 3 层的交换机绑定，
/// 画在第 1 层能让「直接绑定」那条线最短，长线留给间接路径。
fn upstream_layer(
    queue: &str,
    bindings: &[BindingInfo],
    layers: &BTreeMap<String, usize>,
) -> usize {
    let mut best: Option<usize> = None;
    for binding in bindings {
        if binding.destination_type != BindingDestination::Queue || binding.destination != queue {
            continue;
        }
        let layer = layers.get(&binding.source).copied().unwrap_or(0) + 1;
        best = Some(best.map_or(layer, |current| current.min(layer)));
    }
    // 没有上游的队列（例如有人手动建了但没绑）：放到第 0 层之后的占位位置。
    best.unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::QueueInfo;
    use crate::domain::topology::{ExchangeInfo, ExchangeKind};

    fn exchange(name: &str) -> ExchangeInfo {
        ExchangeInfo {
            name: name.to_owned(),
            vhost: "/".to_owned(),
            kind: "direct".to_owned(),
            exchange_type: ExchangeKind::Direct,
            internal: false,
            message_rate: 0.0,
        }
    }

    fn binding(
        source: &str,
        destination: &str,
        kind: BindingDestination,
        routing_key: &str,
    ) -> BindingInfo {
        BindingInfo {
            source: source.to_owned(),
            destination: destination.to_owned(),
            destination_type: kind,
            routing_key: routing_key.to_owned(),
            arguments: Vec::new(),
        }
    }

    fn queue(name: &str, messages: u64, consumers: u32) -> QueueInfo {
        QueueInfo {
            name: name.to_owned(),
            vhost: "/".to_owned(),
            consumers,
            messages,
        }
    }

    fn topology(
        exchanges: Vec<ExchangeInfo>,
        bindings: Vec<BindingInfo>,
        queues: Vec<QueueInfo>,
    ) -> RabbitMqTopology {
        RabbitMqTopology {
            exchanges,
            bindings,
            queues,
        }
    }

    #[test]
    fn same_name_exchange_and_queue_stay_separate() {
        // `orders` 既是交换机也是队列，是很常见的命名。合并成一个节点就错了。
        let graph = build(&topology(
            vec![exchange("orders")],
            vec![binding(
                "orders",
                "orders",
                BindingDestination::Queue,
                "orders",
            )],
            vec![queue("orders", 3, 1)],
        ));
        assert_eq!(graph.nodes.len(), 2);
        let ids: Vec<&str> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
        assert!(ids.contains(&"e:orders"));
        assert!(ids.contains(&"q:orders"));
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].from, "e:orders");
        assert_eq!(graph.edges[0].to, "q:orders");
    }

    #[test]
    fn cycle_does_not_hang_and_layers_are_finite() {
        // `a -> b -> a` 在 AMQP 里合法。BFS 遇到已定层的节点就停，不会绕圈。
        let graph = build(&topology(
            vec![exchange("a"), exchange("b")],
            vec![
                binding("a", "b", BindingDestination::Exchange, ""),
                binding("b", "a", BindingDestination::Exchange, ""),
            ],
            Vec::new(),
        ));
        assert_eq!(graph.nodes.len(), 2);
        // 环上的节点至少要有一层，不能两个都卡在第 0 层之外。
        assert!(graph.layers >= 1);
        assert!(graph.nodes.iter().all(|node| node.layer < graph.layers));
    }

    #[test]
    fn default_exchange_is_kept_as_root() {
        let graph = build(&topology(
            Vec::new(),
            vec![binding(
                "",
                "orders.q",
                BindingDestination::Queue,
                "orders.q",
            )],
            vec![queue("orders.q", 0, 0)],
        ));
        let root = graph
            .nodes
            .iter()
            .find(|node| node.id == "e:")
            .expect("默认交换机不该被丢掉");
        assert_eq!(root.layer, 0);
        let target = graph
            .nodes
            .iter()
            .find(|node| node.id == "q:orders.q")
            .expect("队列节点缺失");
        assert_eq!(target.layer, 1);
    }

    #[test]
    fn queue_layer_follows_earliest_upstream() {
        // 同一个队列既能被第 0 层的交换机直投，也能从第 1 层的交换机中转：
        // 画在最近的那一层，长线留给间接路径。
        let graph = build(&topology(
            vec![exchange("front"), exchange("direct")],
            vec![
                binding("front", "direct", BindingDestination::Exchange, ""),
                binding("direct", "sink", BindingDestination::Queue, "k"),
                binding("front", "sink", BindingDestination::Queue, "k"),
            ],
            vec![queue("sink", 1, 1)],
        ));
        let sink = graph
            .nodes
            .iter()
            .find(|node| node.id == "q:sink")
            .expect("队列节点缺失");
        // `front` 与 `direct` 都没有上游（互相之间那条边不算上游），都是第 0 层。
        assert_eq!(sink.layer, 1);
    }

    #[test]
    fn dangling_binding_reference_is_still_drawn() {
        // 绑定表引用了一个已经删掉的交换机：它必须画出来，那就是「断链」的样子。
        let graph = build(&topology(
            Vec::new(),
            vec![
                binding("ghost", "back", BindingDestination::Exchange, ""),
                binding("back", "done.q", BindingDestination::Queue, "done"),
            ],
            vec![queue("done.q", 5, 0)],
        ));
        assert!(graph.nodes.iter().any(|node| node.id == "e:ghost"));
        assert!(graph.nodes.iter().any(|node| node.id == "e:back"));
        assert_eq!(graph.edges.len(), 2);
    }

    #[test]
    fn queue_metrics_are_attached() {
        let graph = build(&topology(
            vec![exchange("orders")],
            vec![binding(
                "orders",
                "orders.q",
                BindingDestination::Queue,
                "k",
            )],
            vec![queue("orders.q", 42, 2)],
        ));
        let node = graph
            .nodes
            .iter()
            .find(|node| node.id == "q:orders.q")
            .expect("队列节点缺失");
        assert_eq!(node.messages, Some(42));
        assert_eq!(node.consumers, Some(2));
    }

    #[test]
    fn rows_are_dense_per_layer() {
        let graph = build(&topology(
            vec![exchange("a"), exchange("b"), exchange("c")],
            Vec::new(),
            Vec::new(),
        ));
        for layer in 0..graph.layers {
            let rows: Vec<usize> = graph
                .nodes
                .iter()
                .filter(|node| node.layer == layer)
                .map(|node| node.row)
                .collect();
            let expected: Vec<usize> = (0..rows.len()).collect();
            assert_eq!(rows, expected, "第 {layer} 层的序号不连续");
        }
    }

    #[test]
    fn oversized_topology_reports_omitted() {
        // 节点数超过上限时必须有 omitted，不能让用户以为拓扑就这么大。
        let queues: Vec<QueueInfo> = (0..MAX_NODES + 20)
            .map(|index| queue(&format!("q{index:04}"), 0, 0))
            .collect();
        let graph = build(&topology(Vec::new(), Vec::new(), queues));
        assert_eq!(graph.nodes.len(), MAX_NODES);
        assert_eq!(graph.omitted, 20);
        assert!(graph.edges.is_empty());
    }

    #[test]
    fn empty_topology_is_empty_graph() {
        let graph = build(&topology(Vec::new(), Vec::new(), Vec::new()));
        assert!(graph.is_empty());
        assert_eq!(graph.layers, 0);
    }

    #[test]
    fn self_binding_is_not_followed() {
        // 交换机绑定到自己是合法的（虽然少见），不该被当成一级。
        let graph = build(&topology(
            vec![exchange("self")],
            vec![binding("self", "self", BindingDestination::Exchange, "")],
            Vec::new(),
        ));
        assert_eq!(graph.nodes.len(), 1);
        assert_eq!(graph.nodes[0].layer, 0);
    }
}
