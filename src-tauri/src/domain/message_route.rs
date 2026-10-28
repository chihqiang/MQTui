//! 发送预览：这条消息会被投到哪些队列。
//!
//! 发送页最贵的错误不是格式填错，而是**发到没人收的地方**：AMQP 收下了，
//! publish 返回成功，界面上也没有任何异常，消息就那么消失了。
//! 所以发送前先把到达队列算出来，没算到就直接说「没人会收到」。
//!
//! 估算依据是绑定表 + 交换机类型，和拓扑洞察同源：这里只做「一条具体消息」
//! 的匹配（多了 routing key 与 headers），不复用那边的聚合结论。
//! 全部是纯函数，不碰网络 —— 规则本来就该能脱网单测。
//!
//! ## 两条不能含糊的规矩
//!
//! 1. **topic 交换机的通配符按 AMQP 规范算**。`#` 是「一个或多个词」，不是
//!    「零个或多个」；一个词里出现两个及以上通配符（`or#der.#`）在服务端
//!    永远不会命中。放宽一条，预览就会说「会到 q」，而消息实际被丢弃 ——
//!    这是这个模块最不能犯的错，它比不给结论糟得多。
//! 2. **不知道就说不知道**。队列列表拉不到时，「默认交换机有没有同名队列」
//!    根本无从判断，此时既不能说「会丢」，也不能说「没事」：
//!    前者会让人把一条本来正常的消息改掉，后者会让人带着静默丢失继续发。

use serde::{Deserialize, Serialize};

use super::message::MessageHeader;
use super::topology::{BindingDestination, BindingInfo, ExchangeInfo, ExchangeKind};

/// 交换机间转发最多跟几跳。
///
/// AMQP 里交换机之间的绑定成环是合法的，跟着走会打转。上限给到 4 跳：
/// 正常的 `topic → fanout → queue` 链路用不到两跳，再深的拓扑人也读不懂。
const MAX_HOPS: usize = 4;

/// 一条消息能到达的队列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachableQueue {
    pub queue: String,
    /// 命中的绑定上的 routing key（fanout 交换机的绑定 key 为空串）。
    pub routing_key: String,
    /// 是否经过交换机间转发才到。`true` 表示这条队列是间接到达的。
    pub via_exchange: bool,
}

/// 发送预览的结论。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRoute {
    /// 交换机名称；空串表示默认交换机。
    pub exchange: String,
    /// 估算到达的队列，按名称去重排序。
    pub queues: Vec<ReachableQueue>,
    /// 交换机类型；交换机不存在时为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_type: Option<ExchangeKind>,
    /// 唯一一条必须让用户知道的话。为空表示「照常发即可」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// 判断所依据的事实是否齐备。
    ///
    /// `false` 时 `queues` 为空只代表「算不出来」，不代表「没人会收到」。
    /// 默认 `true`，只有调用方确实缺数据时才会被改成 `false`。
    #[serde(default = "default_known")]
    pub bindings_known: bool,
}

fn default_known() -> bool {
    true
}

impl SendRoute {
    /// 有没有把握说「没人会收到」。
    ///
    /// 两种算不出来的情况不给出「会丢」的结论：
    /// - `headers` 交换机的匹配参数不在预览请求里（用户没填 x-match 那一套）；
    /// - 队列列表没拉到，默认交换机的「同名直投」无从判断（`bindings_known`）。
    fn knowable(&self) -> bool {
        self.bindings_known && !matches!(self.exchange_type, Some(ExchangeKind::Headers))
    }
}

/// 计算一条消息的到达队列。
///
/// - `exchange` 空串表示默认交换机：它不走绑定表，只按 routing key 精确投同名队列；
/// - 交换机不存在时给 warning，而不是空列表 —— 两者含义完全不同；
/// - 算出 0 条队列时给 warning：这是发送页唯一「发出去等于丢」的路径。
pub fn predict(
    exchanges: &[ExchangeInfo],
    bindings: &[BindingInfo],
    queue_names: &[String],
    exchange: &str,
    routing_key: &str,
    headers: &[MessageHeader],
) -> SendRoute {
    let found = exchanges.iter().find(|item| item.name == exchange);
    let exchange_type = found.map(|item| item.exchange_type);

    if !exchange.is_empty() && found.is_none() {
        return SendRoute {
            exchange: exchange.to_owned(),
            queues: Vec::new(),
            exchange_type: None,
            warning: Some(format!(
                "交换机 {exchange} 不在当前拓扑里：发出去不会报错，但没有任何队列收得到"
            )),
            bindings_known: true,
        };
    }

    let mut reached: Vec<ReachableQueue> = Vec::new();
    let mut visited: Vec<String> = Vec::new();
    walk(
        exchange,
        exchange_type,
        routing_key,
        headers,
        bindings,
        queue_names,
        false,
        &mut visited,
        &mut reached,
        0,
    );

    reached.sort_by(|a, b| {
        a.queue
            .cmp(&b.queue)
            .then(a.routing_key.cmp(&b.routing_key))
    });
    // 同一个队列被多条绑定命中时只留第一条：列表的意义是「哪些队列收得到」。
    reached.dedup_by(|a, b| a.queue == b.queue);

    let route = SendRoute {
        exchange: exchange.to_owned(),
        queues: reached,
        exchange_type,
        warning: None,
        bindings_known: true,
    };

    if route.queues.is_empty() && route.knowable() {
        let detail = if exchange_type.is_some() || exchange.is_empty() {
            "这个交换机没有匹配上任何队列"
        } else {
            "交换机或绑定还没建好"
        };
        return SendRoute {
            warning: Some(format!(
                "{detail}：publish 会成功，消息随即被丢弃，且不会有任何回报"
            )),
            ..route
        };
    }

    route
}

/// 从 `exchange` 出发，把命中的队列塞进 `reached`。
///
/// 默认交换机单独一条规则：它忽略绑定表，按 routing key 直投同名队列。
#[allow(clippy::too_many_arguments)]
fn walk(
    exchange: &str,
    exchange_type: Option<ExchangeKind>,
    routing_key: &str,
    headers: &[MessageHeader],
    bindings: &[BindingInfo],
    queue_names: &[String],
    from_exchange_hop: bool,
    visited: &mut Vec<String>,
    reached: &mut Vec<ReachableQueue>,
    depth: usize,
) {
    if depth > MAX_HOPS || visited.iter().any(|name| name == exchange) {
        return;
    }
    visited.push(exchange.to_owned());

    if exchange.is_empty() {
        if queue_names.iter().any(|name| name == routing_key) {
            reached.push(ReachableQueue {
                queue: routing_key.to_owned(),
                routing_key: routing_key.to_owned(),
                via_exchange: from_exchange_hop,
            });
        }
        return;
    }

    for binding in bindings.iter().filter(|item| item.source == exchange) {
        if !matches(
            exchange_type.unwrap_or(ExchangeKind::Unknown),
            &binding.routing_key,
            routing_key,
            &binding.arguments,
            headers,
        ) {
            continue;
        }
        match binding.destination_type {
            BindingDestination::Queue => reached.push(ReachableQueue {
                queue: binding.destination.clone(),
                routing_key: binding.routing_key.clone(),
                via_exchange: from_exchange_hop,
            }),
            BindingDestination::Exchange => {
                // 交换机间转发时，下一跳的匹配依据换成这条绑定的 key：
                // fanout 绑定的 key 是空串，正好等于「原样带过去」。
                let next_key = if binding.routing_key.is_empty() {
                    routing_key
                } else {
                    &binding.routing_key
                };
                walk(
                    &binding.destination,
                    None,
                    next_key,
                    headers,
                    bindings,
                    queue_names,
                    true,
                    visited,
                    reached,
                    depth + 1,
                );
            }
        }
    }
}

/// 这条绑定能不能被这条消息命中。
fn matches(
    kind: ExchangeKind,
    binding_key: &str,
    routing_key: &str,
    arguments: &[super::KeyValue],
    headers: &[MessageHeader],
) -> bool {
    match kind {
        ExchangeKind::Fanout => true,
        ExchangeKind::Direct => binding_key == routing_key,
        ExchangeKind::Topic => topic_matches(binding_key, routing_key),
        ExchangeKind::Headers => headers_match(arguments, headers),
        // 未知类型（x-delayed-message 之类）底层多半是四种之一，按最宽的口径算。
        ExchangeKind::Unknown => true,
    }
}

/// AMQP topic 交换机的匹配：`*` 匹配**恰好一个**词，`#` 匹配**一个或多个**词，
/// 词以 `.` 分隔。
///
/// 两条都是规范写死的，不是实现选择：
///
/// - `#` 不吞零个词。绑定 `order.#` 匹配 `order.created`，**不匹配** `order`。
///   按「零到多个」实现会让预览对一条实际会被丢弃的消息说「会到 q」。
/// - 一个词里只能有一个通配符，且必须独占该词。`order*`、`a*b.c`、`or#der.#`
///   这类绑定在服务端永远不会命中，这里跟着判不命中，而不是「尽力理解」它的意图。
///
/// 反过来也有一条：绑定 key 为空串是合法的（默认交换机之外的交换机也允许），
/// 它只匹配空的 routing key。这是「确定不匹配」，不是「不知道」。
fn topic_matches(pattern: &str, key: &str) -> bool {
    let pattern: Vec<&str> = pattern.split('.').collect();
    let key: Vec<&str> = if key.is_empty() {
        Vec::new()
    } else {
        key.split('.').collect()
    };
    topic_match_at(&pattern, &key)
}

fn topic_match_at(pattern: &[&str], key: &[&str]) -> bool {
    match pattern.split_first() {
        None => key.is_empty(),
        Some((head, rest)) => match *head {
            "#" => {
                // `#` 至少吞掉一个词，再让剩下的模式去配剩下的 key。
                (1..=key.len()).any(|skip| topic_match_at(rest, &key[skip..]))
            }
            "*" => !key.is_empty() && topic_match_at(rest, &key[1..]),
            literal if is_wildcard_token(literal) => false,
            literal => key.first() == Some(&literal) && topic_match_at(rest, &key[1..]),
        },
    }
}

/// 词里含通配符但又不是单独一个 `*` / `#`：服务端不接受这种写法，永不命中。
fn is_wildcard_token(word: &str) -> bool {
    word.contains('*') || word.contains('#')
}

/// headers 交换机的匹配：`x-match` 为 `all`（默认）时每条参数都要对上，
/// 为 `any` 时命中一条即可。命名以 `x-` 开头的参数是交换机配置，不参与比较。
fn headers_match(arguments: &[super::KeyValue], headers: &[MessageHeader]) -> bool {
    let require_all = arguments
        .iter()
        .find(|item| item.key == "x-match")
        .map(|item| item.value != "any")
        .unwrap_or(true);

    let pairs: Vec<(&str, &str)> = arguments
        .iter()
        .filter(|item| !item.key.starts_with("x-"))
        .map(|item| (item.key.as_str(), item.value.as_str()))
        .collect();
    if pairs.is_empty() {
        // 没有匹配参数时 headers 交换机不转发任何消息。
        return false;
    }

    let hit = |(name, value): &(&str, &str)| {
        headers
            .iter()
            .any(|header| header.key == *name && header.value == *value)
    };
    if require_all {
        pairs.iter().all(hit)
    } else {
        pairs.iter().any(hit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::topology::ExchangeInfo;

    fn exchange(name: &str, kind: ExchangeKind) -> ExchangeInfo {
        ExchangeInfo {
            name: name.to_owned(),
            vhost: "/".to_owned(),
            kind: String::from("direct"),
            exchange_type: kind,
            internal: false,
            message_rate: 0.0,
        }
    }

    fn binding(
        source: &str,
        destination: &str,
        destination_type: BindingDestination,
        key: &str,
    ) -> BindingInfo {
        BindingInfo {
            source: source.to_owned(),
            destination: destination.to_owned(),
            destination_type,
            routing_key: key.to_owned(),
            arguments: Vec::new(),
        }
    }

    fn header(key: &str, value: &str) -> MessageHeader {
        MessageHeader {
            key: key.to_owned(),
            value: value.to_owned(),
        }
    }

    #[test]
    fn direct_exchange_routes_by_exact_key() {
        let exchanges = vec![exchange("orders", ExchangeKind::Direct)];
        let bindings = vec![
            binding("orders", "q.new", BindingDestination::Queue, "new"),
            binding("orders", "q.audit", BindingDestination::Queue, "audit"),
        ];
        let route = predict(&exchanges, &bindings, &[], "orders", "new", &[]);

        assert_eq!(route.queues.len(), 1);
        assert_eq!(route.queues[0].queue, "q.new");
        assert!(route.warning.is_none());
    }

    #[test]
    fn fanout_ignores_routing_key() {
        let exchanges = vec![exchange("broadcast", ExchangeKind::Fanout)];
        let bindings = vec![
            binding("broadcast", "q.a", BindingDestination::Queue, ""),
            binding("broadcast", "q.b", BindingDestination::Queue, ""),
        ];
        let route = predict(&exchanges, &bindings, &[], "broadcast", "whatever", &[]);
        assert_eq!(
            route
                .queues
                .iter()
                .map(|q| q.queue.as_str())
                .collect::<Vec<_>>(),
            ["q.a", "q.b"]
        );
    }

    #[test]
    fn topic_wildcards_match_words() {
        assert!(topic_matches("order.*", "order.created"));
        assert!(!topic_matches("order.*", "order.created.cn"));
        // `#` 至少吃掉一个词：`order.#` 不匹配光秃秃的 `order`。
        assert!(!topic_matches("order.#", "order"));
        assert!(topic_matches("order.#", "order.created"));
        assert!(topic_matches("order.#", "order.created.cn"));
        // 只有 `#` 的绑定同样要求 key 非空。
        assert!(!topic_matches("#", ""));
        assert!(topic_matches("#", "any"));
        assert!(!topic_matches("order.create", "order.created"));
    }

    #[test]
    fn topic_exchange_routes_through_wildcard_binding() {
        let exchanges = vec![exchange("events", ExchangeKind::Topic)];
        let bindings = vec![
            binding("events", "q.cn", BindingDestination::Queue, "order.*.cn"),
            binding("events", "q.all", BindingDestination::Queue, "order.#"),
        ];
        let route = predict(
            &exchanges,
            &bindings,
            &[],
            "events",
            "order.created.cn",
            &[],
        );
        assert_eq!(
            route
                .queues
                .iter()
                .map(|q| q.queue.as_str())
                .collect::<Vec<_>>(),
            ["q.all", "q.cn"]
        );
    }

    #[test]
    fn default_exchange_delivers_to_same_name_queue_only() {
        let bindings: Vec<BindingInfo> = Vec::new();
        let queues = vec!["orders".to_owned()];
        let route = predict(&[], &bindings, &queues, "", "orders", &[]);
        assert_eq!(route.queues.len(), 1);
        assert!(route.warning.is_none());

        let missing = predict(&[], &bindings, &queues, "", "payments", &[]);
        assert!(missing.queues.is_empty());
        assert!(missing.warning.is_some(), "投不到任何队列必须给出提示");
    }

    #[test]
    fn unknown_exchange_is_called_out_not_silently_empty() {
        let route = predict(&[], &[], &[], "nope", "key", &[]);
        assert!(route.queues.is_empty());
        assert_eq!(route.exchange_type, None);
        assert!(route.warning.expect("应有提示").contains("不在当前拓扑里"));
    }

    #[test]
    fn exchange_hop_is_followed_and_cannot_loop() {
        let exchanges = vec![
            exchange("front", ExchangeKind::Fanout),
            exchange("back", ExchangeKind::Direct),
        ];
        let bindings = vec![
            binding("front", "back", BindingDestination::Exchange, ""),
            binding("back", "q.final", BindingDestination::Queue, "any"),
            // 回环：back 再绑回 front，跟下去会打转。
            binding("back", "front", BindingDestination::Exchange, "any"),
        ];
        let route = predict(&exchanges, &bindings, &[], "front", "any", &[]);
        assert_eq!(route.queues.len(), 1);
        assert_eq!(route.queues[0].queue, "q.final");
        assert!(route.queues[0].via_exchange);
    }

    #[test]
    fn headers_exchange_matches_all_by_default() {
        let mut target = exchange("h", ExchangeKind::Headers);
        let _ = &mut target;
        let exchanges = vec![target];
        let mut bindings = vec![binding("h", "q.h", BindingDestination::Queue, "")];
        bindings[0].arguments = vec![
            super::super::KeyValue {
                key: "x-match".to_owned(),
                value: "all".to_owned(),
            },
            super::super::KeyValue {
                key: "type".to_owned(),
                value: "order".to_owned(),
            },
        ];

        let hit = predict(
            &exchanges,
            &bindings,
            &[],
            "h",
            "",
            &[header("type", "order")],
        );
        assert_eq!(hit.queues.len(), 1);

        let miss = predict(
            &exchanges,
            &bindings,
            &[],
            "h",
            "",
            &[header("type", "user")],
        );
        // headers 交换机的匹配参数不在预览请求里时算不出来，所以不给「会丢」的结论。
        assert!(miss.queues.is_empty());
        assert!(miss.warning.is_none());
    }

    /// 通配符必须独占一个词。服务端对 `order*` 这类写法永不命中，
    /// 预览若「理解意图」判成命中，就会对一条实际被丢弃的消息说「会到 q」。
    #[test]
    fn wildcard_must_own_its_word() {
        assert!(!topic_matches("order*", "orders"));
        assert!(!topic_matches("a*b.c", "axb.c"));
        assert!(!topic_matches("or#der.#", "order.created"));
        assert!(!topic_matches("order.#.", "order.created"));
        // 合法写法仍然成立，别把整类通配都判死。
        assert!(topic_matches("*.created", "order.created"));
        assert!(topic_matches("order.*.#", "order.a.b.c"));
    }

    /// 绑定 key 是空串时，topic 交换机只匹配空的 routing key。
    /// 这是「确定不匹配」，不是「不知道」—— 结论要敢给出会丢。
    #[test]
    fn empty_binding_key_only_matches_empty_routing_key() {
        let exchanges = vec![exchange("t", ExchangeKind::Topic)];
        let bindings = vec![binding("t", "q.any", BindingDestination::Queue, "")];

        // 队列名不能是空串（AMQP 里那是不合法的队列名），所以这条绑定实际打不到任何队列。
        // 关键在于结论的措辞：这是「算得出投不到」，不是「算不出来」。
        let hit = predict(&exchanges, &bindings, &[], "t", "", &[]);
        assert!(hit.bindings_known);

        let miss = predict(&exchanges, &bindings, &[], "t", "order.created", &[]);
        assert!(miss.queues.is_empty());
        assert!(
            miss.warning.expect("应给出会丢的提示").contains("丢弃"),
            "算得出确实投不到，就要明说会丢"
        );
    }

    /// 预览对 topic 交换机的判定要与规范一致：`order.#` 收不到 `order`。
    #[test]
    fn topic_hash_binding_does_not_swallow_missing_word() {
        let exchanges = vec![exchange("t", ExchangeKind::Topic)];
        let bindings = vec![binding(
            "t",
            "q.child",
            BindingDestination::Queue,
            "order.#",
        )];

        let hit = predict(&exchanges, &bindings, &[], "t", "order.created", &[]);
        assert_eq!(hit.queues.len(), 1);

        let miss = predict(&exchanges, &bindings, &[], "t", "order", &[]);
        assert!(miss.queues.is_empty());
        assert!(miss.warning.is_some());
    }

    /// 队列列表没拿到时不能给出「会丢」的结论：那只是查不到。
    #[test]
    fn unknown_queue_list_degrades_instead_of_claiming_loss() {
        let mut route = predict(&[], &[], &[], "", "order.created", &[]);
        assert!(route.warning.is_some(), "空列表本身会被判成投不到任何队列");

        route.bindings_known = false;
        route.warning = None;
        // 降级后同一个空结果不再等于「会丢」：界面据此改口径。
        assert!(!route.bindings_known);
        assert_eq!(route.queues.len(), 0);
    }
}
