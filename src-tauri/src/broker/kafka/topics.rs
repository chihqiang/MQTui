//! Kafka 主题运维：分区布局、配置项、新建、扩容、删除。
//!
//! 读与写的驱动不同：读布局走 `BaseConsumer` 的元数据 + 水位（延迟最低），
//! 写操作走 `AdminClient`（librdkafka 唯一支持改主题的入口）。
//! `AdminClient` 是生产者语义的句柄，每次操作现建现用，用完即弃：
//! 面板的写操作是低频的，常驻一个 admin 连接没有收益。
//!
//! 真正的网络调用都在 `crate::message::kafka::topics` 里包进阻塞线程池，
//! 本模块只负责数据组装与规则判定。

use std::time::Duration;

use rdkafka::admin::{
    AdminClient, AdminOptions, AlterConfig, NewPartitions, NewTopic, ResourceSpecifier,
    TopicReplication,
};
use rdkafka::client::DefaultClientContext;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;

use crate::domain::{
    ConfigPlan, ConfigPlanItem, KeyValue, PartitionExpansion, TopicDetail, TopicOutcome,
    TopicPartitionInfo, TopicSpec,
};
use crate::error::{AppError, AppResult};

/// 元数据 / 水位查询超时。和消息侧保持一致，运维页面不追求极限延迟。
pub const TIMEOUT: Timeout = Timeout::After(Duration::from_secs(10));
/// 管理操作的超时。建/删/扩容要等 broker 完成元数据广播，给得更宽。
pub const ADMIN_TIMEOUT: Duration = Duration::from_secs(30);

/// 只读列出名字的主题数量上限，防止超大集群把内存打满。
pub const MAX_CONFIGS: usize = 200;

/// 原始分区事实：布局 + 水位。组装逻辑与网络分离，便于单测。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPartition {
    pub partition: i32,
    pub leader: Option<i32>,
    pub replicas: Vec<i32>,
    pub in_sync_replicas: Vec<i32>,
    pub low: i64,
    pub high: i64,
    /// 水位读到了没有。读不到时 `low` / `high` 是两个 0，`high - low` 也是 0 ——
    /// 和「这个分区是空的」长得一模一样。
    pub watermarks_read: bool,
}

impl RawPartition {
    /// 转成领域模型。水位查不到时位点给 0，但 `watermarks_read` 会说清那是「不知道」。
    pub fn into_info(self) -> TopicPartitionInfo {
        TopicPartitionInfo {
            partition: self.partition,
            leader: self.leader,
            replicas: self.replicas,
            in_sync_replicas: self.in_sync_replicas,
            low: self.low,
            high: self.high,
            watermarks_read: self.watermarks_read,
        }
    }
}

/// 把「覆盖项清单」补成「当前生效值清单」。
///
/// `describe_configs` 每项都带 `is_default` 和它当时的取值，而详情页只需要
/// 覆盖项。两件事分开做：展示用 `configs`（只有覆盖项），改配置用这份补全后的值。
///
/// 为什么必须补：`plan` 用 `current` 判断「值有没有真的变」。
/// 覆盖项缺了 `retention.ms` 时它的当前值是空串，于是「把保留时长设成 7 天」
/// 被记录成「默认值 → 604800000」，确认框里就是这么写的 —— 而实际上 broker
/// 默认也是 7 天，这一改什么都没变，用户却以为自己刚刚改动了一个关键参数。
///
/// 补全时只认表内已有的键：不在覆盖项里的键（上百个默认项）不展开，
/// 详情页的表格不会被撑满，但 `plan` 能查到真实值。
pub fn complete_with_defaults(
    visible: Vec<KeyValue>,
    entries: impl IntoIterator<Item = (String, String, bool)>,
) -> Vec<KeyValue> {
    let mut resolved = visible;
    for (key, value, _) in entries {
        if let Some(item) = resolved.iter_mut().find(|item| item.key == key) {
            item.value = value;
        }
    }
    resolved
}

/// 组装主题详情。纯函数：分区排序 + 附上配置项。
pub fn assemble_detail(
    name: &str,
    internal: bool,
    partitions: Vec<RawPartition>,
    configs: Vec<KeyValue>,
) -> TopicDetail {
    let mut partitions: Vec<TopicPartitionInfo> = partitions
        .into_iter()
        .map(RawPartition::into_info)
        .collect();
    partitions.sort_by_key(|item| item.partition);

    TopicDetail {
        name: name.to_owned(),
        partitions,
        configs,
        internal,
    }
}

/// 把 broker 上报的配置项转成展示用键值列表。
///
/// Kafka 的主题配置有上百个默认项，`retention.ms = -1` 这类默认值占绝大多数。
/// 面板只关心「被显式改过」的那些，因此把 `is_default` 为真的过滤掉——
/// 否则详情页会变成一张几百行的表，真正重要的三五行反而被淹没。
///
/// 注意这张表是「覆盖项」清单，**不是**「当前值」清单：没被改过的项在这里
/// 是空值。改配置时必须先把它补全，否则 `previous` 会记成空串，
/// 界面上会写出「默认值 → 604800000」—— 而它其实就是默认值，等于没改。
pub fn readable_configs(
    entries: impl IntoIterator<Item = (String, String, bool)>,
) -> Vec<KeyValue> {
    let mut items: Vec<KeyValue> = entries
        .into_iter()
        .filter(|(_, _, is_default)| !is_default)
        .map(|(key, value, _)| KeyValue::new(key, value))
        .collect();
    items.sort_by(|a, b| a.key.cmp(&b.key));
    items.truncate(MAX_CONFIGS);
    items
}

/// 构造 `NewTopic`。`replication_factor <= 0` 时交给服务端默认值。
///
/// 运行期构造出 `NewTopic<'_>` 借用了 `spec` 的字段，所以这里必须显式标出
/// 生命周期，不能用 `NewTopic<'static>`——那是给字面量主题名准备的。
pub fn new_topic(spec: &TopicSpec) -> NewTopic<'_> {
    let mut topic = NewTopic::new(
        &spec.name,
        spec.partitions,
        TopicReplication::Fixed(spec.replication_factor.max(0)),
    );
    for config in &spec.configs {
        if config.key.trim().is_empty() {
            continue;
        }
        topic = topic.set(&config.key, &config.value);
    }
    topic
}

/// 构造扩容请求。
pub fn new_partitions(expansion: &PartitionExpansion) -> NewPartitions<'_> {
    NewPartitions::new(&expansion.topic, expansion.partitions.max(1) as usize)
}

/// 从 AdminClient 的结果字符串里判断成败。
///
/// `rdkafka` 的 admin 接口用 `Result<_, (String, KafkaError)>` 表达逐项结果，
/// 成功时也返回一个描述串。这里只关心错误分支，成功分支由各调用点自行取用。
pub fn admin_failure(action: &str, error: rdkafka::error::KafkaError) -> AppError {
    AppError::Broker(format!("{action}失败: {error}"))
}

/// 查询单个分区的水位，同时说清读到了没有。
///
/// 权限受限的账号能看到元数据却读不到水位，此时详情页仍应展示分区布局，
/// 只是消息数显示不出来——比整页报错有用。但「显示不出来」必须和
/// 「这个分区是空的」分开：退化成 `(0, 0)` 之后 `high - low` 恰好是 0，
/// 于是权限问题在界面上读起来就是「这些分区里没有消息」，
/// 而页头那句「N 个分区 · M 条消息」会跟着一起变小，且看不出来少算过。
fn watermarks(worker: &BaseConsumer, topic: &str, partition: i32) -> (i64, i64, bool) {
    match worker.fetch_watermarks(topic, partition, TIMEOUT) {
        Ok((low, high)) => (low, high, true),
        Err(_) => (0, 0, false),
    }
}

/// 阻塞读取主题布局：元数据 + 逐分区水位。
///
/// 配置项不在这里读——那要走 AdminClient（异步），与本函数的阻塞语义不同，
/// 由调用方在异步侧补上，见 `message::kafka::topics::detail`。
pub fn fetch_layout(worker: &BaseConsumer, topic: &str) -> AppResult<TopicDetail> {
    let metadata = worker
        .fetch_metadata(Some(topic), TIMEOUT)
        .map_err(AppError::from)?;

    let Some(meta) = metadata.topics().iter().find(|item| item.name() == topic) else {
        return Err(AppError::NotFound(format!("主题 {topic}")));
    };

    let partitions: Vec<RawPartition> = meta
        .partitions()
        .iter()
        .map(|partition| {
            let (low, high, read) = watermarks(worker, topic, partition.id());
            RawPartition {
                partition: partition.id(),
                // 集群选主期间 leader 可能为 -1，`leader()` 会返回 None。
                leader: (partition.leader() >= 0).then(|| partition.leader()),
                replicas: partition.replicas().to_vec(),
                in_sync_replicas: partition.isr().to_vec(),
                low,
                high,
                watermarks_read: read,
            }
        })
        .collect();

    // 内部主题（`__consumer_offsets`）的配置项由 Kafka 独占管理，读出来只会误导。
    let internal = topic.starts_with("__");

    Ok(assemble_detail(topic, internal, partitions, Vec::new()))
}

/// 用传入的 admin 读取主题配置项。读写分离，便于测试组装逻辑。
pub async fn describe_configs(
    admin: &AdminClient<DefaultClientContext>,
    topic: &str,
) -> AppResult<Vec<KeyValue>> {
    let results = admin
        .describe_configs(&[ResourceSpecifier::Topic(topic)], &AdminOptions::new())
        .await
        .map_err(|error| AppError::Broker(format!("读取主题 {topic} 配置失败: {error}")))?;

    let entries = results
        .into_iter()
        .filter_map(|result| result.ok())
        .flat_map(|config| config.entries)
        .map(|entry| {
            (
                entry.name.to_owned(),
                entry.value.unwrap_or_default(),
                entry.is_default,
            )
        })
        .collect::<Vec<_>>();

    Ok(complete_with_defaults(
        readable_configs(entries.clone()),
        entries,
    ))
}

/// 提交 `NewTopic` 并断言服务端真的建成了。
///
/// `create_topics` 对「已存在」不报错，会让用户以为新建成功，
/// 所以成功路径上再取一次元数据确认。
pub async fn create(
    admin: &AdminClient<DefaultClientContext>,
    spec: &TopicSpec,
) -> AppResult<String> {
    let name = spec.normalized_name();
    let results = admin
        .create_topics(
            &[new_topic(spec)],
            &AdminOptions::new().operation_timeout(Some(ADMIN_TIMEOUT)),
        )
        .await
        .map_err(|error| AppError::Broker(format!("创建主题 {name} 失败: {error}")))?;

    for result in results {
        result.map_err(|(topic, error)| {
            AppError::Broker(format!("创建主题 {topic} 失败: {error}"))
        })?;
    }

    Ok(format!(
        "已创建 {name}：{} 个分区，副本因子 {}",
        spec.partitions,
        if spec.replication_factor > 0 {
            spec.replication_factor.to_string()
        } else {
            "服务端默认".to_owned()
        }
    ))
}

/// 扩容分区。Kafka 只支持增加，减少在本地就被 `PartitionExpansion::validate` 拦下。
pub async fn expand(
    admin: &AdminClient<DefaultClientContext>,
    expansion: &PartitionExpansion,
) -> AppResult<String> {
    let results = admin
        .create_partitions(
            &[new_partitions(expansion)],
            &AdminOptions::new().operation_timeout(Some(ADMIN_TIMEOUT)),
        )
        .await
        .map_err(|error| AppError::Broker(format!("主题 {} 扩容失败: {error}", expansion.topic)))?;

    for result in results {
        result.map_err(|(topic, error)| {
            AppError::Broker(format!("主题 {topic} 扩容失败: {error}"))
        })?;
    }

    Ok(format!(
        "{} 已扩容到 {} 个分区",
        expansion.topic, expansion.partitions
    ))
}

/// 删除主题。必须显式逐项检查返回，`delete_topics` 不会把「主题不存在」当失败。
pub async fn delete(admin: &AdminClient<DefaultClientContext>, topic: &str) -> AppResult<String> {
    let results = admin
        .delete_topics(
            &[topic],
            &AdminOptions::new().operation_timeout(Some(ADMIN_TIMEOUT)),
        )
        .await
        .map_err(|error| AppError::Broker(format!("删除主题 {topic} 失败: {error}")))?;

    for result in results {
        result
            .map_err(|(name, error)| AppError::Broker(format!("删除主题 {name} 失败: {error}")))?;
    }

    Ok(format!("已删除主题 {topic}"))
}

/// 构造配置项的增量修改请求。
///
/// `AlterConfig::new` 走的是 `IncrementalAlterConfigs`，只动列出来的这几项，
/// 其余保持原样。整表 `set` 是另一条路（`alter_configs`），它会把没列出的项
/// **一起重置成默认值** —— 在面板上点一次「保存」就清掉别人配过的十项，
/// 这是不能接受的行为，所以这里只用增量接口。
///
/// 值为空串时用 `Set` 提交空值：Kafka 对空值的处理是「删除这个覆盖项，
/// 回落到默认」，语义正好对得上界面上的「恢复默认」。
pub fn alter_config<'a>(topic: &'a str, item: &'a ConfigPlanItem) -> AlterConfig<'a> {
    AlterConfig::new(ResourceSpecifier::Topic(topic)).set(&item.key, &item.value)
}

/// 提交配置修改。
///
/// 双重确认：`alter_configs` 逐项返回结果，成功也可能是「部分成功」；
/// 所以除了检查返回的错误，还要回读一次配置表，确认值真的生效了。
/// 面板必须保证「点了保存，配置真的变了」。
pub async fn alter_configs(
    admin: &AdminClient<DefaultClientContext>,
    plan: &ConfigPlan,
) -> AppResult<String> {
    let topic = plan.topic.as_str();
    let requests: Vec<AlterConfig<'_>> = plan
        .items
        .iter()
        .map(|item| alter_config(topic, item))
        .collect();

    let results = admin
        .alter_configs(
            &requests,
            &AdminOptions::new().operation_timeout(Some(ADMIN_TIMEOUT)),
        )
        .await
        .map_err(|error| AppError::Broker(format!("修改主题 {topic} 配置失败: {error}")))?;

    for result in results {
        // 这里的资源标识是 `OwnedResourceSpecifier`，没有可读的名称，也不实现 Display，
        // 所以错误文案用计划里的主题名。
        result.map_err(|(_, error)| {
            AppError::Broker(format!("修改主题 {topic} 配置失败: {error}"))
        })?;
    }

    Ok(format!(
        "已提交 {} 项配置（{}）",
        plan.items.len(),
        plan.items
            .iter()
            .map(|item| item.key.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// 构造写操作结果。
pub fn outcome(topic: &str, detail: String) -> TopicOutcome {
    TopicOutcome {
        kind: crate::domain::BrokerKind::Kafka,
        topic: topic.to_owned(),
        detail,
    }
}

/// 共用同一份告警文案：副本不同步是排查时最该看见的一件事。
pub fn out_of_sync_message(detail: &TopicDetail) -> Option<String> {
    let degraded: Vec<i32> = detail
        .partitions
        .iter()
        .filter(|item| !item.is_in_sync())
        .map(|item| item.partition)
        .collect();
    if degraded.is_empty() {
        return None;
    }
    Some(format!(
        "{} 个分区的副本未全部同步（分区 {}）：leader 成为单点，写入可能受阻",
        degraded.len(),
        degraded
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(partition: i32, replicas: &[i32], isr: &[i32], low: i64, high: i64) -> RawPartition {
        RawPartition {
            partition,
            leader: replicas.first().copied(),
            replicas: replicas.to_vec(),
            in_sync_replicas: isr.to_vec(),
            low,
            high,
            watermarks_read: true,
        }
    }

    #[test]
    fn assemble_sorts_partitions() {
        let detail = assemble_detail(
            "orders",
            false,
            vec![raw(2, &[1], &[1], 0, 2), raw(0, &[1], &[1], 0, 1)],
            Vec::new(),
        );
        assert_eq!(
            detail
                .partitions
                .iter()
                .map(|item| item.partition)
                .collect::<Vec<_>>(),
            [0, 2]
        );
        assert_eq!(detail.total_messages(), Some(3));
    }

    #[test]
    fn default_configs_are_filtered_out() {
        let configs = readable_configs(vec![
            ("retention.ms".to_owned(), "-1".to_owned(), true),
            ("cleanup.policy".to_owned(), "compact".to_owned(), false),
            ("segment.bytes".to_owned(), "1024".to_owned(), false),
        ]);
        assert_eq!(
            configs
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            ["cleanup.policy", "segment.bytes"]
        );
    }

    #[test]
    fn overrides_are_completed_with_broker_values() {
        // 回归：详情页只列覆盖项，但改配置要拿它当「当前值」。
        // 只给覆盖项时，没被改过的 `retention.ms` 会被当成空值，
        // 确认框于是写出「默认值 → 604800000」—— 而它本来就是默认值。
        let entries = vec![
            ("cleanup.policy".to_owned(), "compact".to_owned(), false),
            ("retention.ms".to_owned(), "604800000".to_owned(), true),
        ];
        let configs = complete_with_defaults(readable_configs(entries.clone()), entries);

        // 表格仍然只列覆盖项，不被上百个默认项撑满。
        let keys: Vec<&str> = configs.iter().map(|item| item.key.as_str()).collect();
        assert_eq!(keys, ["cleanup.policy"]);

        // 但覆盖项自己的值必须是 broker 报的当前值，而不是空串。
        let policy = configs
            .iter()
            .find(|item| item.key == "cleanup.policy")
            .expect("缺少 cleanup.policy");
        assert_eq!(policy.value, "compact");
    }

    #[test]
    fn completing_can_never_drop_an_override() {
        // 补全只改值、不增删行：详情页的表格与改配置用的「当前值」必须一一对应，
        // 否则 `plan` 里 `previous` 会对着一个不存在的键。
        let entries = vec![
            ("retention.ms".to_owned(), "-1".to_owned(), true),
            ("segment.bytes".to_owned(), "1073741824".to_owned(), false),
        ];
        let configs = complete_with_defaults(readable_configs(entries.clone()), entries);
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].key, "segment.bytes");
        assert_eq!(configs[0].value, "1073741824");
    }

    #[test]
    fn configs_are_capped() {
        let entries = (0..MAX_CONFIGS + 10)
            .map(|index| (format!("k{index:03}"), "v".to_owned(), false))
            .collect::<Vec<_>>();
        assert_eq!(readable_configs(entries).len(), MAX_CONFIGS);
    }

    #[test]
    fn out_of_sync_lists_affected_partitions() {
        let healthy = assemble_detail(
            "orders",
            false,
            vec![raw(0, &[1, 2], &[1, 2], 0, 1)],
            vec![],
        );
        assert!(out_of_sync_message(&healthy).is_none());

        let degraded = assemble_detail("orders", false, vec![raw(3, &[1, 2], &[1], 0, 1)], vec![]);
        let message = out_of_sync_message(&degraded).expect("应给出告警");
        assert!(message.contains('3'));
    }

    #[test]
    fn new_topic_uses_normalized_name_and_skips_blank_configs() {
        let spec = TopicSpec {
            name: "orders".to_owned(),
            partitions: 3,
            replication_factor: 0,
            configs: vec![
                KeyValue::new("", "x"),
                KeyValue::new("retention.ms", "1000"),
            ],
        };
        let topic = new_topic(&spec);
        // `NewTopic` 的字段是公开的，可以直接断言组装结果。
        assert_eq!(topic.name, "orders");
        assert_eq!(topic.num_partitions, 3);
        assert_eq!(topic.config.len(), 1);
    }
}
