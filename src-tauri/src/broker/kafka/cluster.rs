//! Kafka 集群页的取数与判读。
//!
//! 集群页要回答三个问题，顺序不能反：
//!
//! 1. **有几个 broker、几个活着** —— 元数据里的 broker 列表；
//! 2. **谁是 controller** —— 没有 controller 时集群不能做任何元数据变更，
//!    新建主题、扩容分区全都会失败，但报错信息通常只说「超时」；
//! 3. **分区副本有没有掉队** —— 这一条决定「消息还写不写得进去」。
//!
//! 判定逻辑（`isr` 与副本数对齐、leader 缺失）放在纯函数里，
//! 取数只做一次元数据请求。面板不主动问 broker 版本：rdkafka 没有可靠的接口，
//! 猜出来的版本会变成一条错误的安全感。

use std::collections::{BTreeMap, HashMap};

use rdkafka::consumer::Consumer;
use rdkafka::util::Timeout;

use crate::domain::cluster_view::summarize;
use crate::domain::{ClusterNode, KeyValue, NodeRole, Overview};
use crate::domain::{ClusterView, TopicInfo};
use crate::error::{AppError, AppResult};

use super::client::{KafkaClient, META_TIMEOUT};

/// 一个 broker 的聚合视图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerStat {
    pub id: i32,
    pub host: String,
    pub port: i32,
    /// 该 broker 作为 leader 的分区数。
    pub leaders: usize,
    /// 该 broker 上「副本数 > ISR 数」的分区数：这些分区正在丢副本。
    pub under_replicated: usize,
}

/// 从元数据里提取的集群快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterRaw {
    pub brokers: Vec<BrokerStat>,
    /// controller 的 broker id。老版本 Kafka 也可能拿不到。
    pub controller: Option<i32>,
    /// 元数据里出现、但不在 broker 列表里的 broker id（已下线）。
    pub offline: Vec<i32>,
    pub topic_count: usize,
    pub partition_count: usize,
}

/// 判定 broker 是否为 offline。
///
/// 元数据里 `brokers()` 只列存活的 broker，分区副本里的 `replicas()` 会带上已下线的 id。
/// 两者相减就是「掉线但仍有分区副本挂在它身上」的那些 —— 这才是要报警的对象。
pub fn offline_brokers(alive: &[BrokerStat], replica_ids: &[i32]) -> Vec<i32> {
    let known: Vec<i32> = alive.iter().map(|broker| broker.id).collect();
    let mut missing: Vec<i32> = replica_ids
        .iter()
        .copied()
        .filter(|id| *id >= 0 && !known.contains(id))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    missing
}

/// 把 broker 统计转成展示节点。
///
/// controller 优先于普通成员：排在最前面的那一行应该是用户最需要确认的状态。
pub fn to_nodes(raw: &ClusterRaw) -> Vec<ClusterNode> {
    let mut nodes: Vec<ClusterNode> = raw
        .brokers
        .iter()
        .map(|broker| {
            let role = if Some(broker.id) == raw.controller {
                NodeRole::Controller
            } else {
                NodeRole::Member
            };
            let endpoint = format!("{}:{}", broker.host, broker.port);
            let mut node =
                ClusterNode::new(format!("broker-{}", broker.id), role).with_endpoint(endpoint);
            node.leaders = Some(broker.leaders);
            node
        })
        .collect();

    for id in &raw.offline {
        nodes.push(
            ClusterNode::new(format!("broker-{id}"), NodeRole::Offline)
                .with_running(false)
                .with_endpoint("(已下线)"),
        );
    }

    nodes.sort_by(|a, b| a.name.cmp(&b.name));
    nodes
}

/// 组装集群页视图：节点 + 报警。
///
/// 这里额外补三条 Kafka 专属判定，`domain::cluster_view` 只管通用的
/// 「谁掉线了」，具体的「没有 controller」「副本掉队」由这边加：
///
/// - 没有 controller：所有元数据变更都会失败，且报错含糊；
/// - 有掉线 broker：它当 leader 的分区正在重新选举，期间读写都会抖；
/// - 有副本掉队的分区：`min.insync.replicas` 满足不了时生产方直接报错。
pub fn view(raw: &ClusterRaw) -> ClusterView {
    let mut base = summarize(&to_nodes(raw));
    if raw.controller.is_none() && !raw.brokers.is_empty() {
        base.alerts.insert(
            0,
            crate::domain::ClusterAlert::warn_pair(
                "没有可用的 controller",
                "新建主题、扩容分区、修改配置都会失败；请检查集群的 controller 选举状态",
            ),
        );
    }
    let under: usize = raw
        .brokers
        .iter()
        .map(|broker| broker.under_replicated)
        .sum();
    if under > 0 {
        base.alerts.push(crate::domain::ClusterAlert::warn_pair(
            format!("{under} 个分区副本掉队"),
            "ISR 短于副本数：这些分区正在丢副本，写入可靠性下降；见各 broker 的掉队计数",
        ));
    }
    base
}

/// 集群概览的键值项。
pub fn overview_items(raw: &ClusterRaw) -> Overview {
    let mut items = vec![
        KeyValue::new("Broker 数", format!("{}（存活）", raw.brokers.len())),
        KeyValue::new("主题数", raw.topic_count.to_string()),
        KeyValue::new("分区数", raw.partition_count.to_string()),
        KeyValue::new(
            "Controller",
            raw.controller.map_or_else(
                || "未选出（元数据变更有风险）".to_owned(),
                |id| format!("broker-{id}"),
            ),
        ),
    ];
    if !raw.offline.is_empty() {
        items.push(KeyValue::new(
            "离线 Broker",
            raw.offline
                .iter()
                .map(|id| format!("broker-{id}"))
                .collect::<Vec<_>>()
                .join("、"),
        ));
    }
    Overview {
        title: "Kafka 集群".to_owned(),
        items,
    }
}

/// 主题分区数的一览，供节点表格与概览复用。
pub fn topic_summary(infos: &[TopicInfo]) -> (usize, usize) {
    let partitions = infos.iter().map(|info| info.partitions).sum();
    (infos.len(), partitions)
}

impl KafkaClient {
    /// 消费组成员数。用来判断「这个组现在还有没有人在跑」。
    ///
    /// 位点重置前必须知道这件事：改完位点，活跃消费者的下一次自动提交就会把它覆盖回去。
    /// 查询失败时由调用方按「有成员」处理（保守方向）。
    pub async fn consumer_group_members(&self, group: &str) -> AppResult<usize> {
        let worker = self.inspection_consumer("mqtui-group-members")?;
        let group = group.to_owned();

        tokio::task::spawn_blocking(move || {
            let list = worker
                .fetch_group_list(Some(&group), Timeout::After(META_TIMEOUT))
                .map_err(AppError::from)?;
            Ok(list
                .groups()
                .iter()
                .find(|item| item.name() == group)
                .map_or(0, |item| item.members().len()))
        })
        .await
        .map_err(|error| AppError::Internal(format!("消费组查询任务失败: {error}")))?
    }

    /// 拉取一次元数据并聚合成集群快照。
    ///
    /// 只发一次请求：集群页要的 broker 列表、controller、分区副本全都在这份元数据里，
    /// 分三次取会出现「broker 列表已刷新、分区副本还是旧的」的自相矛盾。
    pub async fn cluster_raw(&self) -> AppResult<ClusterRaw> {
        let worker = self.inspection_consumer("mqtui-cluster")?;
        let metadata = tokio::task::spawn_blocking(move || {
            worker.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 元数据任务失败: {error}")))?
        .map_err(AppError::from)?;

        Ok(assemble_raw(&metadata))
    }

    /// 集群页视图。
    pub async fn cluster_view(&self) -> AppResult<ClusterView> {
        Ok(view(&self.cluster_raw().await?))
    }
}

/// 把 rdkafka 的元数据聚合成 `ClusterRaw`。
///
/// 抽成函数是为了能脱离网络单测：`Metadata` 本身不好构造，
/// 但聚合口径（谁当 leader、谁掉队）必须能验证。
fn assemble_raw(metadata: &rdkafka::metadata::Metadata) -> ClusterRaw {
    let mut brokers: HashMap<i32, BrokerStat> = metadata
        .brokers()
        .iter()
        .map(|broker| {
            (
                broker.id(),
                BrokerStat {
                    id: broker.id(),
                    host: broker.host().to_owned(),
                    port: broker.port(),
                    leaders: 0,
                    under_replicated: 0,
                },
            )
        })
        .collect();

    let mut replica_ids = Vec::new();
    let mut partition_count = 0usize;
    for topic in metadata.topics() {
        for partition in topic.partitions() {
            partition_count += 1;
            if let Some(broker) = brokers.get_mut(&partition.leader()) {
                broker.leaders += 1;
            }
            let replicas = partition.replicas();
            let isr = partition.isr();
            replica_ids.extend(replicas.iter().copied());
            if isr.len() < replicas.len() {
                // 记到**任何一个**存活的副本所在 broker 上，而不是 leader 头上：
                // 选主期间 leader 是 -1，leader 落在离线 broker 上时也查不到人。
                // 以前那条 `get_mut(&leader)` 在这两种时刻会静默归零 ——
                // 而掉副本最严重的时刻正好是这种时刻。
                for replica in replicas {
                    if let Some(broker) = brokers.get_mut(replica) {
                        broker.under_replicated += 1;
                        break;
                    }
                }
            }
        }
    }

    let mut broker_list: Vec<BrokerStat> = brokers.into_values().collect();
    broker_list.sort_by_key(|broker| broker.id);
    let offline = offline_brokers(&broker_list, &replica_ids);

    ClusterRaw {
        brokers: broker_list,
        // `orig_broker_id` 在拿不到 controller 时返回 -1。
        controller: (metadata.orig_broker_id() >= 0).then(|| metadata.orig_broker_id()),
        offline,
        topic_count: metadata.topics().len(),
        partition_count,
    }
}

/// 按 broker 汇总分区 leader 分布，用于判断「负载是否偏斜」。
pub fn leader_spread(brokers: &[BrokerStat]) -> BTreeMap<i32, usize> {
    brokers
        .iter()
        .map(|broker| (broker.id, broker.leaders))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker(id: i32, leaders: usize, under: usize) -> BrokerStat {
        BrokerStat {
            id,
            host: format!("kafka-{id}"),
            port: 9092,
            leaders,
            under_replicated: under,
        }
    }

    fn raw() -> ClusterRaw {
        ClusterRaw {
            brokers: vec![broker(1, 4, 0), broker(2, 2, 1), broker(3, 2, 0)],
            controller: Some(1),
            offline: Vec::new(),
            topic_count: 8,
            partition_count: 8,
        }
    }

    #[test]
    fn offline_ids_come_from_replica_list_minus_alive() {
        let alive = vec![broker(1, 0, 0)];
        assert_eq!(offline_brokers(&alive, &[1, 2, 2, -1]), vec![2]);
    }

    #[test]
    fn negative_leader_is_not_treated_as_offline_broker() {
        // leader = -1 表示分区没有 leader，不是一个 broker id。
        let alive = vec![broker(1, 0, 0)];
        assert!(offline_brokers(&alive, &[-1]).is_empty());
    }

    #[test]
    fn controller_gets_its_own_role() {
        let nodes = to_nodes(&raw());
        let controller = nodes.iter().find(|node| node.name == "broker-1").unwrap();
        assert_eq!(controller.role, NodeRole::Controller);
        assert_eq!(controller.leaders, Some(4));
        let member = nodes.iter().find(|node| node.name == "broker-2").unwrap();
        assert_eq!(member.role, NodeRole::Member);
    }

    #[test]
    fn offline_broker_becomes_a_node_with_running_false() {
        let mut snapshot = raw();
        snapshot.offline = vec![9];
        let nodes = to_nodes(&snapshot);
        let missing = nodes.iter().find(|node| node.name == "broker-9").unwrap();
        assert!(!missing.running);
        assert_eq!(missing.role, NodeRole::Offline);
    }

    #[test]
    fn missing_controller_is_the_first_alert() {
        let mut snapshot = raw();
        snapshot.controller = None;
        let view = view(&snapshot);
        assert!(view.alerts[0].title.contains("controller"));
    }

    #[test]
    fn under_replicated_partitions_are_summed_across_brokers() {
        let view = view(&raw());
        assert!(
            view.alerts
                .iter()
                .any(|alert| alert.title.contains("副本掉队"))
        );
    }

    #[test]
    fn healthy_cluster_has_no_alerts() {
        let mut snapshot = raw();
        for item in &mut snapshot.brokers {
            item.under_replicated = 0;
        }
        assert!(view(&snapshot).alerts.is_empty());
    }

    #[test]
    fn overview_reports_controller_and_offline_brokers() {
        let mut snapshot = raw();
        snapshot.offline = vec![7];
        let overview = overview_items(&snapshot);
        assert!(overview.items.iter().any(|item| item.key == "离线 Broker"));
        assert!(
            overview
                .items
                .iter()
                .any(|item| item.key == "Controller" && item.value == "broker-1")
        );
    }

    #[test]
    fn leader_spread_keeps_every_broker_even_at_zero() {
        let spread = leader_spread(&[broker(1, 0, 0), broker(2, 5, 0)]);
        assert_eq!(spread.get(&1), Some(&0));
        assert_eq!(spread.get(&2), Some(&5));
    }
}
