//! 拓扑洞察：交换机到队列的路由估算。
//!
//! 回答两类问题：
//! - 「交换机的消息到底会落到哪些队列」：按交换机类型估算候选队列；
//! - 「消息发出去为什么没反应」：找出没有任何出站绑定的交换机。
//!
//! 这里全部是纯函数，不碰网络。管理 API 只提供绑定表与速率，聚合判断在本地做，
//! 一是省往返，二是这些规则本来就该能脱网单测。

use serde::{Deserialize, Serialize};

use super::topology::{BindingDestination, BindingInfo, ExchangeInfo, ExchangeKind};

/// 路由估算的把握程度。
///
/// 面板看的是统计信息，不是真实投递记录，所以这里必须显式声明「知道多少」，
/// 而不是给一个看起来精确的队列列表。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteConfidence {
    /// 路由完全由绑定决定（fanout / headers / direct 或全量绑定），队列列表是完备的。
    Certain,
    /// topic 交换机只看了已存在的绑定，未展开 `*` / `#` 的通配可能。
    Partial,
    /// 默认交换机只有「队列名直投」这一条隐式规则。
    Implicit,
}

impl RouteConfidence {
    /// 展示给用户的说明。返回 `None` 表示无需额外提示。
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Certain => None,
            Self::Partial => {
                Some("topic 交换机的估算只看已存在的绑定：`*` 与 `#` 会匹配到尚未建绑定的队列名")
            }
            Self::Implicit => Some("默认交换机不走绑定表，按队列名精确投递"),
        }
    }
}

/// 队列侧的吞吐指标，供路由估算判断「消息到了队列之后有没有人处理」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMetrics {
    pub name: String,
    /// 队列中待消费的消息数。
    pub messages: u64,
    pub consumers: u32,
    /// 入队速率（每秒）。
    pub incoming_rate: f64,
    /// 投递速率（每秒）。
    pub deliver_rate: f64,
}

impl QueueMetrics {
    /// 队列在堆积、但没有任何消费者。这类队列是「沉默的垃圾桶」：
    /// 从交换机角度看不出异常，问题全堆在这里。
    pub fn is_stalled(&self) -> bool {
        self.messages > 0 && self.consumers == 0
    }
}

/// 一条从交换机到队列的估算路由。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHop {
    /// 经过的交换机（链路的第一跳）。
    pub exchange: String,
    /// 终点队列名。
    pub queue: String,
    /// 命中的 routing key 模式；来自绑定表。
    pub routing_key: String,
    /// 这条链路上是否还存在队列到队列的间接跳（交换机间的绑定）。
    pub via_exchange: bool,
    /// 命中该绑定的投放占比。仅当同一交换机的多个绑定共享 routing key 时有意义。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<f64>,
}

/// 单个交换机的前往队列的估算。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRoute {
    /// 交换机名称，空串表示默认交换机。
    pub exchange: String,
    /// 估算出的队列名，去重且按名称排序。
    pub queues: Vec<String>,
    pub confidence: RouteConfidence,
    /// 出站绑定总数（含指向其它交换机的绑定）。
    pub bindings: usize,
    /// 出站绑定指向交换机而非队列的条数。这类交换机是「中转站」，队列列表会偏少。
    pub exchange_hops: usize,
    /// 出入详情，按 routing key 展开。
    pub hops: Vec<RouteHop>,
}

/// 交换机视角的拓扑洞察。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyInsight {
    /// 每个交换机的估算路由。
    pub routes: Vec<ExchangeRoute>,
    /// 没有任何出站绑定的交换机名。它们收到消息后一律静默丢弃。
    pub dead_ends: Vec<String>,
    /// 出站绑定指向交换机、但链路最终没落到任何队列的交换机名。
    ///
    /// 这类是「半死的」：消息进来了、也转发走了，但在中途掉进黑洞。
    /// 只看出站绑定数量是发现不了的。
    pub dangling: Vec<String>,
    /// 被可达路由指向、但当前没有消费者且仍有堆积的队列。
    pub stalled: Vec<String>,
}

/// 计算拓扑洞察。
///
/// `exchanges` 来自 `/api/exchanges`，`bindings` 来自 `/api/bindings`。
/// 默认交换机即使不在 `exchanges` 里也可能有队列绑定，因此单独补一个节点。
pub fn analyze(exchanges: &[ExchangeInfo], bindings: &[BindingInfo]) -> TopologyInsight {
    analyze_with_queues(exchanges, bindings, &[])
}

/// 在 `analyze` 基础上补上队列吞吐，多给出「堆积但没人消费」的队列。
///
/// 单独一个入口是因为路由估算本身不依赖队列指标：
/// 管理 API 拿不到速率时（老版本或权限受限），前面的结论仍然成立。
pub fn analyze_with_queues(
    exchanges: &[ExchangeInfo],
    bindings: &[BindingInfo],
    queues: &[QueueMetrics],
) -> TopologyInsight {
    let mut names: Vec<String> = exchanges.iter().map(|item| item.name.clone()).collect();
    // 默认交换机在绑定表里以空串出现，补进来才能看到「按队列名直投」这条路。
    names.push(String::new());
    names.sort();
    names.dedup();

    let routes: Vec<ExchangeRoute> = names
        .iter()
        .map(|name| route_for(name, exchanges, bindings))
        .collect();

    let dead_ends = routes
        .iter()
        .filter(|route| route.bindings == 0)
        .map(|route| route.exchange.clone())
        .collect();

    let dangling = routes
        .iter()
        .filter(|route| route.bindings > 0 && route.queues.is_empty())
        .map(|route| route.exchange.clone())
        .collect();

    // 只统计被某条可达路由指向的队列：没人绑定、也没人投递的队列与拓扑无关。
    let reachable: std::collections::BTreeSet<&str> = routes
        .iter()
        .flat_map(|route| route.queues.iter().map(String::as_str))
        .collect();
    let stalled = queues
        .iter()
        .filter(|queue| reachable.contains(queue.name.as_str()) && queue.is_stalled())
        .map(|queue| queue.name.clone())
        .collect();

    TopologyInsight {
        routes,
        dead_ends,
        dangling,
        stalled,
    }
}

/// 单个交换机的估算路由。
fn route_for(name: &str, exchanges: &[ExchangeInfo], bindings: &[BindingInfo]) -> ExchangeRoute {
    let outgoing: Vec<&BindingInfo> = bindings
        .iter()
        .filter(|binding| binding.source == name)
        .collect();

    let exchange_hops = outgoing
        .iter()
        .filter(|binding| binding.destination_type == BindingDestination::Exchange)
        .count();

    let mut hops = Vec::new();
    // 队列直接绑定：routing key 就是真实的匹配依据。
    for binding in outgoing
        .iter()
        .filter(|binding| binding.destination_type == BindingDestination::Queue)
    {
        hops.push(RouteHop {
            exchange: name.to_owned(),
            queue: binding.destination.clone(),
            routing_key: binding.routing_key.clone(),
            via_exchange: false,
            share: share_of(&outgoing, &binding.routing_key),
        });
    }

    // 交换机间绑定：链路在下一跳继续，这里按下一跳的出站队列继续展开一层。
    // 只展开一层是因为 AMQP 里环状的交换机绑定是合法的，递归展开会打转。
    for binding in outgoing
        .iter()
        .filter(|binding| binding.destination_type == BindingDestination::Exchange)
    {
        for queue in downstream_queues(&binding.destination, bindings) {
            hops.push(RouteHop {
                exchange: name.to_owned(),
                queue: queue.to_owned(),
                routing_key: binding.routing_key.clone(),
                via_exchange: true,
                share: None,
            });
        }
    }

    hops.sort_by(|a, b| {
        a.queue
            .cmp(&b.queue)
            .then(a.routing_key.cmp(&b.routing_key))
    });

    let mut queues: Vec<String> = hops.iter().map(|hop| hop.queue.clone()).collect();
    queues.sort();
    queues.dedup();

    let confidence = confidence_of(name, exchanges, &hops);
    ExchangeRoute {
        exchange: name.to_owned(),
        queues,
        confidence,
        bindings: outgoing.len(),
        exchange_hops,
        hops,
    }
}

/// 交换机类型决定路由估算的把握程度。
fn confidence_of(name: &str, exchanges: &[ExchangeInfo], hops: &[RouteHop]) -> RouteConfidence {
    if name.is_empty() {
        return RouteConfidence::Implicit;
    }
    match exchanges
        .iter()
        .find(|item| item.name == name)
        .map(|item| item.exchange_type)
    {
        // fanout 忽略 routing key，headers 只看参数，两者都是「有多少绑定就有多少条路」。
        Some(ExchangeKind::Fanout | ExchangeKind::Headers) => RouteConfidence::Certain,
        Some(ExchangeKind::Direct) => RouteConfidence::Certain,
        // topic 的通配会命中尚未建绑定的队列名，direct 的未知类型同此处理。
        _ if hops.is_empty() => RouteConfidence::Certain,
        _ => RouteConfidence::Partial,
    }
}

/// 下一跳交换机直接绑定的队列。只在下一跳是交换机时才可能非空。
fn downstream_queues<'a>(exchange: &str, bindings: &'a [BindingInfo]) -> Vec<&'a str> {
    bindings
        .iter()
        .filter(|binding| {
            binding.source == exchange && binding.destination_type == BindingDestination::Queue
        })
        .map(|binding| binding.destination.as_str())
        .collect()
}

/// 同一源交换机、同一 routing key 的绑定均分，否则返回 `None`。
///
/// `fanout` 交换机上所有绑定的 routing key 都是空串，这种情况下每条路实际都会收到
/// 全量消息，均分会变成误导——所以只在绑定确实按 routing key 区分时才给占比。
fn share_of(outgoing: &[&BindingInfo], routing_key: &str) -> Option<f64> {
    if routing_key.is_empty() {
        return None;
    }
    let same_key = outgoing
        .iter()
        .filter(|binding| binding.routing_key == routing_key)
        .count();
    if same_key <= 1 {
        return None;
    }
    Some(1.0 / same_key as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(name: &str, kind: ExchangeKind) -> ExchangeInfo {
        ExchangeInfo {
            name: name.to_owned(),
            vhost: "/".to_owned(),
            // 测试里 kind 只用于展示，与 exchange_type 保持一致即可。
            kind: String::from("direct"),
            exchange_type: kind,
            internal: false,
            message_rate: 0.0,
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

    #[test]
    fn direct_exchange_routes_to_its_bound_queues() {
        let exchanges = vec![exchange("orders", ExchangeKind::Direct)];
        let bindings = vec![
            binding("orders", "orders.q", BindingDestination::Queue, "order.new"),
            binding("orders", "audit.q", BindingDestination::Queue, "audit"),
        ];
        let insight = analyze(&exchanges, &bindings);

        let route = insight
            .routes
            .iter()
            .find(|item| item.exchange == "orders")
            .expect("缺少 orders 路由");
        assert_eq!(
            route.queues,
            vec!["audit.q".to_owned(), "orders.q".to_owned()]
        );
        assert_eq!(route.confidence, RouteConfidence::Certain);
        // 没有绑定的只有默认交换机，它每次分析都会被补进来。
        assert_eq!(insight.dead_ends, vec![String::new()]);
    }

    #[test]
    fn exchange_without_bindings_is_a_dead_end() {
        let exchanges = vec![
            exchange("orders", ExchangeKind::Direct),
            exchange("lonely", ExchangeKind::Fanout),
        ];
        let insight = analyze(&exchanges, &[]);
        assert!(insight.dead_ends.contains(&"lonely".to_owned()));
        assert!(insight.dead_ends.contains(&"orders".to_owned()));
        // 默认交换机没有任何绑定时同样是死路，它由服务端隐式提供。
        assert!(insight.dead_ends.contains(&String::new()));
    }

    #[test]
    fn exchange_chain_keeps_going_until_a_queue() {
        let exchanges = vec![
            exchange("front", ExchangeKind::Fanout),
            exchange("back", ExchangeKind::Direct),
        ];
        let bindings = vec![
            binding("front", "back", BindingDestination::Exchange, ""),
            binding("back", "done.q", BindingDestination::Queue, "done"),
        ];
        let insight = analyze(&exchanges, &bindings);
        let route = insight
            .routes
            .iter()
            .find(|item| item.exchange == "front")
            .expect("缺少 front 路由");
        assert_eq!(route.queues, vec!["done.q".to_owned()]);
        assert_eq!(route.exchange_hops, 1);
        assert!(route.hops.iter().all(|hop| hop.via_exchange));
    }

    #[test]
    fn chain_without_terminal_queue_is_dangling() {
        let exchanges = vec![
            exchange("front", ExchangeKind::Fanout),
            exchange("back", ExchangeKind::Fanout),
        ];
        // front 把消息转给 back，但 back 谁也没绑：消息在这条链上消失。
        let bindings = vec![binding("front", "back", BindingDestination::Exchange, "")];
        let insight = analyze(&exchanges, &bindings);

        assert!(insight.dangling.contains(&"front".to_owned()));
        // back 自己没有任何出站绑定，属于死路。
        assert!(insight.dead_ends.contains(&"back".to_owned()));
        assert!(!insight.dead_ends.contains(&"front".to_owned()));
    }

    #[test]
    fn topic_exchange_reports_partial_confidence() {
        let exchanges = vec![exchange("events", ExchangeKind::Topic)];
        let bindings = vec![binding(
            "events",
            "events.q",
            BindingDestination::Queue,
            "order.*",
        )];
        let insight = analyze(&exchanges, &bindings);
        let route = insight
            .routes
            .iter()
            .find(|item| item.exchange == "events")
            .expect("缺少 events 路由");
        assert_eq!(route.confidence, RouteConfidence::Partial);
        assert!(route.confidence.note().is_some());
    }

    #[test]
    fn default_exchange_is_implicit() {
        let bindings = vec![binding(
            "",
            "orders.q",
            BindingDestination::Queue,
            "orders.q",
        )];
        let insight = analyze(&[], &bindings);
        let route = insight
            .routes
            .iter()
            .find(|item| item.exchange.is_empty())
            .expect("缺少默认交换机路由");
        assert_eq!(route.queues, vec!["orders.q".to_owned()]);
        assert_eq!(route.confidence, RouteConfidence::Implicit);
    }

    #[test]
    fn share_only_applies_to_duplicated_routing_keys() {
        let exchanges = vec![exchange("broadcast", ExchangeKind::Direct)];
        // fanout 的绑定 routing key 都是空串：每条路都收全量，均分是误导。
        let fanout_like = vec![
            binding("broadcast", "a.q", BindingDestination::Queue, ""),
            binding("broadcast", "b.q", BindingDestination::Queue, ""),
        ];
        let insight = analyze(&exchanges, &fanout_like);
        assert!(
            insight
                .routes
                .iter()
                .flat_map(|route| route.hops.iter())
                .all(|hop| hop.share.is_none())
        );

        // 同一 routing key 绑到两个队列时，消息会被复制两份，各占一半。
        let duplicated = vec![
            binding("broadcast", "a.q", BindingDestination::Queue, "same"),
            binding("broadcast", "b.q", BindingDestination::Queue, "same"),
        ];
        let insight = analyze(&exchanges, &duplicated);
        let route = insight
            .routes
            .iter()
            .find(|item| item.exchange == "broadcast")
            .expect("缺少 broadcast 路由");
        let shares: Vec<f64> = route.hops.iter().filter_map(|hop| hop.share).collect();
        assert_eq!(shares.len(), 2);
        assert!((shares[0] - 0.5).abs() < f64::EPSILON);

        // 唯一 routing key 不需要占比，多一个字段只会分散注意力。
        let unique = vec![binding(
            "broadcast",
            "a.q",
            BindingDestination::Queue,
            "only",
        )];
        let insight = analyze(&exchanges, &unique);
        assert!(
            insight
                .routes
                .iter()
                .flat_map(|route| route.hops.iter())
                .all(|hop| hop.share.is_none())
        );
    }

    #[test]
    fn stalled_queues_must_be_reachable() {
        let exchanges = vec![exchange("orders", ExchangeKind::Direct)];
        let bindings = vec![binding(
            "orders",
            "orders.q",
            BindingDestination::Queue,
            "new",
        )];
        let queues = vec![
            // 可达且有堆积无消费者：交换机侧看不出异常，问题全在队列上。
            QueueMetrics {
                name: "orders.q".to_owned(),
                messages: 12,
                consumers: 0,
                incoming_rate: 3.0,
                deliver_rate: 0.0,
            },
            // 有人消费就不算卡住。
            QueueMetrics {
                name: "orders.q.worker".to_owned(),
                messages: 5,
                consumers: 2,
                incoming_rate: 1.0,
                deliver_rate: 1.0,
            },
            // 空队列不算卡住。
            QueueMetrics {
                name: "empty.q".to_owned(),
                messages: 0,
                consumers: 0,
                incoming_rate: 0.0,
                deliver_rate: 0.0,
            },
        ];
        let insight = analyze_with_queues(&exchanges, &bindings, &queues);
        assert_eq!(insight.stalled, vec!["orders.q".to_owned()]);
    }

    #[test]
    fn analyze_without_queue_metrics_still_works() {
        let exchanges = vec![exchange("orders", ExchangeKind::Direct)];
        let insight = analyze(&exchanges, &[]);
        assert!(insight.stalled.is_empty());
        assert_eq!(insight.dead_ends.len(), 2);
    }

    #[test]
    fn routes_are_deduplicated_and_sorted() {
        let exchanges = vec![exchange("fan", ExchangeKind::Fanout)];
        let bindings = vec![
            binding("fan", "z.q", BindingDestination::Queue, ""),
            binding("fan", "a.q", BindingDestination::Queue, ""),
            binding("fan", "a.q", BindingDestination::Queue, ""),
        ];
        let insight = analyze(&exchanges, &bindings);
        let route = insight
            .routes
            .iter()
            .find(|item| item.exchange == "fan")
            .expect("缺少 fan 路由");
        assert_eq!(route.queues, vec!["a.q".to_owned(), "z.q".to_owned()]);
        // 绑定条数仍按原始数量计，去重只作用于队列名。
        assert_eq!(route.bindings, 3);
    }
}
