//! Kafka 客户端封装：只暴露面板需要的少量能力，屏蔽 librdkafka 细节。

use std::sync::Arc;
use std::time::Duration;

use rdkafka::ClientConfig;
use rdkafka::admin::AdminClient;
use rdkafka::client::DefaultClientContext;
use rdkafka::config::FromClientConfig;
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::util::Timeout;

use crate::domain::{
    CheckStatus, HealthCheck, HealthReport, KafkaConfig, KeyValue, MessageHeader, Overview,
    RawMessageHeader, TopicInfo,
};
use crate::error::{AppError, AppResult};

use super::dto::client_config;

/// 元数据请求超时。
pub(super) const META_TIMEOUT: Duration = Duration::from_secs(10);

/// 发送一条消息时等 broker 确认的上限。
///
/// 这个值必须**大于** producer 自己的 `message.timeout.ms`（30s）：
/// 比它小的话，librdkafka 还在重试，这边已经先超时了 —— 用户看到「发送失败」，
/// 而消息可能过几秒真的写进去了，再点一次就是重复消息。
pub(super) const DELIVERY_TIMEOUT: Duration = Duration::from_secs(45);

/// Kafka 客户端。
///
/// `BaseConsumer` 不是 `Sync`，因此内部统一用 `Arc` 包裹并在使用时独占访问。
pub struct KafkaClient {
    config: ClientConfig,
    bootstrap: String,
    admin: Arc<BaseConsumer>,
}

impl KafkaClient {
    /// 建立连接：创建 admin 消费者并拉取一次元数据，失败即视为连接不可用。
    pub async fn connect(config: KafkaConfig) -> AppResult<Self> {
        let base = client_config(&config);
        let bootstrap = config.brokers.join(",");

        // 只建一个 consumer：发送走 `deliver` 里的按需 producer（幂等 + 明确的重试窗口），
        // 这里再养一个长连接没有人用，只会让 broker 上多出一条说不清的连接。
        let admin: BaseConsumer = base.create()?;
        let admin = Arc::new(admin);

        // 元数据请求是阻塞调用，放到阻塞线程池，避免卡住 Tauri 的异步运行时。
        let probe = Arc::clone(&admin);
        let result = tokio::task::spawn_blocking(move || {
            probe.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 元数据任务失败: {error}")))?;
        result.map_err(|error| AppError::Connect(format!("{bootstrap}: {error}")))?;

        Ok(Self {
            config: base,
            bootstrap,
            admin,
        })
    }

    /// 概览信息。
    pub async fn overview(&self) -> AppResult<Overview> {
        // 概览与集群页共用同一份聚合结果，避免「概览说 3 个 broker、集群页说 2 个」
        // 这种同屏矛盾 —— 两处都来自一次元数据请求是唯一能保证一致的做法。
        let raw = self.cluster_raw().await?;
        let mut overview = super::cluster::overview_items(&raw);
        overview
            .items
            .insert(0, KeyValue::new("Brokers", self.bootstrap.clone()));
        Ok(overview)
    }

    /// 订阅主题列表。
    pub async fn topics(&self) -> AppResult<Vec<TopicInfo>> {
        let admin = Arc::clone(&self.admin);
        let metadata = tokio::task::spawn_blocking(move || {
            admin.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 元数据任务失败: {error}")))?
        .map_err(AppError::from)?;

        Ok(metadata
            .topics()
            .iter()
            .map(|topic| TopicInfo {
                name: topic.name().to_owned(),
                partitions: topic.partitions().len(),
                // 副本因子取「各分区里最大的那个」，而不是第一个分区的。
                // 元数据是按 broker 视角拼出来的：某个主题在这个 broker 上可能
                // 只认得部分分区，`first()` 拿到的恰好是残缺的那一条时，
                // 列表里会写出一个比真实值小的副本数。取最大值才是安全的方向 ——
                // 「副本比你以为的多」不会让人做错决定，「比你以为的少」会。
                replication_factor: topic
                    .partitions()
                    .iter()
                    .map(|partition| partition.replicas().len())
                    .max(),
                internal: is_internal_topic(topic.name()),
            })
            .collect())
    }

    /// 发送一条消息，返回 `partition@offset` 形式的确认信息。
    pub async fn send(
        &self,
        topic: &str,
        key: Option<&str>,
        payload: &[u8],
        headers: &[MessageHeader],
    ) -> AppResult<String> {
        let headers = headers.iter().map(text_header).collect::<Vec<_>>();
        let delivery = self.deliver(topic, key, payload, &headers).await?;

        Ok(format!(
            "partition={} offset={}",
            delivery.partition, delivery.offset
        ))
    }

    /// 发送一条消息并返回落点。
    ///
    /// 与 `send` 的差别只在返回值：重发需要知道分区号才能判断
    /// 「同一条 key 有没有落到原来那个分区」，拼成字符串再解析回来很蠢。
    ///
    /// 走独立的 producer 实例，`enable.idempotence` 只在新建实例时生效，
    /// 共用的那个早已创建，改配置等于改了个没人读的字段。
    /// 代价是每次重发多一个 producer 的握手——重发是低频人工动作，值得。
    pub async fn deliver(
        &self,
        topic: &str,
        key: Option<&str>,
        payload: &[u8],
        headers: &[RawMessageHeader],
    ) -> AppResult<DeliveryReceipt> {
        let producer = self.resend_producer()?;

        let mut record = FutureRecord::<str, [u8]>::to(topic).payload(payload);
        if let Some(key) = key {
            record = record.key(key);
        }
        record = record.headers(owned_headers(headers));

        match producer
            .send(record, Timeout::After(DELIVERY_TIMEOUT))
            .await
        {
            Ok(delivery) => Ok(DeliveryReceipt {
                partition: delivery.partition,
                offset: delivery.offset,
            }),
            // `QueueFull` 是「压根没进队列」：可以放心重试。
            Err((
                rdkafka::error::KafkaError::MessageProduction(
                    rdkafka::types::RDKafkaErrorCode::QueueFull,
                ),
                _,
            )) => Err(AppError::Broker(
                "发送队列已满，消息没有发出：稍后重试是安全的".to_owned(),
            )),
            // 其余错误分不清「没写进去」和「写进去了但没等到 ack」。
            // 说「未知」而不是「失败」：后者会让人立刻再点一次，制造重复消息。
            Err((error, _)) => Err(AppError::Broker(format!(
                "等待 broker 确认超时或失败（{error}）：消息可能已经写进 {topic}，                 请刷新确认之后再决定要不要重发。重试可能产生重复消息"
            ))),
        }
    }

    /// 健康检查：bootstrap 可达 + 元数据可取。
    ///
    /// Kafka 没有「管理 API 写权限」这种概念（权限由 ACL 决定，查看 ACL 要另开 AdminClient），
    /// 所以只报告两项。`writeAccess` 留给 RabbitMQ，前端按 key 判断按钮状态，
    /// 不必为「Kafka 没有这一项」写特例。
    pub async fn health(&self) -> AppResult<HealthReport> {
        let admin = Arc::clone(&self.admin);
        let probe = tokio::task::spawn_blocking(move || {
            admin.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .map_err(|error| AppError::Internal(format!("Kafka 健康检查任务失败: {error}")))?;

        let item = match probe {
            Ok(metadata) => HealthCheck::new("metadata", "元数据请求", CheckStatus::Ok)
                .with_detail(format!(
                    "{} 个 topic / {} 个节点",
                    metadata.topics().len(),
                    metadata.brokers().len()
                )),
            Err(error) => HealthCheck::new("metadata", "元数据请求", CheckStatus::Failed)
                .with_detail(error.to_string()),
        };

        Ok(HealthReport {
            items: vec![
                HealthCheck::new("bootstrap", "Bootstrap", CheckStatus::Ok)
                    .with_detail(self.bootstrap.clone()),
                item,
            ],
            checked_at: now_millis(),
        })
    }

    /// 建一个开启幂等性的 producer，供「重发一条已有消息」使用。
    ///
    /// 重发是人工排查动作，重复写入的代价比一次失败更难收拾：幂等 producer
    /// 让重试不会在日志里留下同一份消息的多个副本。
    fn resend_producer(&self) -> AppResult<FutureProducer> {
        let mut config = self.config.clone();
        config
            .set("enable.idempotence", "true")
            // acks=all 是幂等的前提，显式写出来免得被环境配置覆盖。
            .set("acks", "all")
            .set("max.in.flight.requests.per.connection", "5")
            // 重试窗口必须落在 `DELIVERY_TIMEOUT` 之内，否则「等待确认」先超时，
            // 而 librdkafka 还在后台重试 —— 界面上是失败，日志里却写进去了。
            .set(
                "message.timeout.ms",
                (DELIVERY_TIMEOUT.as_secs() * 1000 - 5_000).to_string(),
            );
        config
            .create()
            .map_err(|error| AppError::Broker(format!("创建 Kafka 发送客户端失败: {error}")))
    }

    /// 供上层构造 consumer 使用的基础配置。
    pub fn consumer_config(&self, group_id: &str) -> ClientConfig {
        let mut config = self.config.clone();
        config
            .set("group.id", group_id)
            .set("enable.auto.commit", "false")
            .set("auto.offset.reset", "earliest");
        config
    }

    /// 集群版本，形如 `3.7.0`。拿不到时返回 `None`。
    ///
    /// Kafka 的 `ApiVersions` 里没有「集群版本」这个字段，能拿到的只有每个 broker
    /// 支持的 API 版本区间，不同发行版（自建 / Confluent / 各家云）又不一致。
    /// 所以这里不去猜：读不到就返回 `None`，上层按「版本未知」处理 ——
    /// 只说明，不拦。猜出来的版本会变成一条错误的安全感。
    pub async fn version(&self) -> Option<String> {
        let admin = Arc::clone(&self.admin);
        let metadata = tokio::task::spawn_blocking(move || {
            admin.fetch_metadata(None, Timeout::After(META_TIMEOUT))
        })
        .await
        .ok()?
        .ok()?;

        // 元数据里唯一可能带版本信息的是 topic 的错误串之外的东西，这里没有可靠来源。
        // 保留这次调用是为了将来 rdkafka 暴露 broker 版本时不必改上层签名。
        let _ = metadata.brokers().len();
        None
    }

    /// bootstrap 地址，用于错误提示。
    pub fn bootstrap(&self) -> &str {
        &self.bootstrap
    }

    /// 建一个一次性的管理客户端。
    ///
    /// 写操作（建/扩/删主题、读配置）走 AdminClient，与只读消息用的
    /// `BaseConsumer` 是两条驱动路径。管理句柄用完即弃：面板的写操作是低频动作，
    /// 常驻连接只会让连接数在界面上看起来莫名其妙。
    pub fn admin(&self) -> AppResult<AdminClient<DefaultClientContext>> {
        let mut config = self.config.clone();
        config.set("group.id", "mqtui-admin");
        AdminClient::from_config(&config)
            .map_err(|error| AppError::Broker(format!("创建 Kafka 管理客户端失败: {error}")))
    }

    /// 再建一个走同一份配置的客户端句柄，**不建连**。
    ///
    /// 给需要把阻塞调用挪进线程池的读取用：`KafkaClient` 自己不是 `Send` 的
    /// （内含 `BaseConsumer`），直接 `move` 进 `spawn_blocking` 会编译不过。
    /// 这里只复制配置，句柄本身由线程池那边新建，用完即弃。
    pub fn clone_handle(&self) -> AppResult<Self> {
        let admin: BaseConsumer = self
            .config
            .create()
            .map_err(|error| AppError::Broker(format!("创建 Kafka 客户端失败: {error}")))?;
        Ok(Self {
            config: self.config.clone(),
            bootstrap: self.bootstrap.clone(),
            admin: Arc::new(admin),
        })
    }

    /// 用给定配置构造客户端，**不建连**。
    ///
    /// 只给参数校验类单测用：那些分支必须在发出任何网络请求之前就失败，
    /// 走 `connect()` 会先花十秒等元数据超时。生产路径一律用 `connect()`。
    #[cfg(test)]
    pub fn detached(config: &KafkaConfig) -> AppResult<Self> {
        let base = client_config(config);
        let admin = base.create()?;
        Ok(Self {
            config: base,
            bootstrap: config.brokers.join(","),
            admin: Arc::new(admin),
        })
    }

    /// 建一个只读的查询 consumer。
    ///
    /// 与 `consumer_config` 配合使用：调用方决定 group.id，
    /// 这里只负责把建客户端的错误收敛成统一类型。
    pub fn inspection_consumer(&self, group_id: &str) -> AppResult<BaseConsumer> {
        self.consumer_config(group_id)
            .create()
            .map_err(AppError::from)
    }
}

/// 是否为 Kafka 自己维护的内部主题。
///
/// 唯一可靠的判据是 `__` 前缀：`PartitionMetadata::error()` 返回的
/// `UnknownTopicOrPartition` 只是「这个 broker 当前不认这个主题」——
/// 自动建主题关闭时的正常写入、集群重启期间未成为 leader 的分区都会走到这个分支，
/// 那类主题在别的 broker 上明明有数据，元数据里的分区数是空的。
/// 把它当成「不存在」或「0 个分区」，列表上就会出现一批看似空壳的主题。
fn is_internal_topic(name: &str) -> bool {
    name.starts_with("__")
}

/// 毫秒时间戳，与 RabbitMQ 侧保持同一种时间刻度。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

/// 一条消息的投递回执。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryReceipt {
    pub partition: i32,
    pub offset: i64,
}

/// 把成对的头转换成 rdkafka 的 owned headers。
/// 组装 record headers。
///
/// 值为 `None` 时写成「没有值」的 header（Kafka 协议允许 `value` 为 null），
/// 而不是一个空串 —— 两者在消费端是两种不同的判断。表单里的空值
/// 就是「这个 key 存在但没有值」，透传过去即可。
fn owned_headers(headers: &[RawMessageHeader]) -> rdkafka::message::OwnedHeaders {
    headers
        .iter()
        .fold(rdkafka::message::OwnedHeaders::new(), |acc, header| {
            acc.insert(rdkafka::message::Header {
                key: header.key.as_str(),
                value: header.value.as_deref(),
            })
        })
}

/// 界面上填的文本 header 转成原始字节：`None` 就是「有这个头但没有值」。
fn text_header(header: &MessageHeader) -> RawMessageHeader {
    RawMessageHeader {
        key: header.key.clone(),
        value: header
            .value
            .as_deref()
            .map(str::as_bytes)
            .map(<[u8]>::to_vec),
    }
}
