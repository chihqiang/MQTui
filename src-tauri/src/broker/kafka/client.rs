//! Kafka 客户端封装：只暴露面板需要的少量能力，屏蔽 librdkafka 细节。

use std::sync::{Arc, Mutex};
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
    ProducerGuarantee, RawMessageHeader, TopicInfo, inspect_producer_options,
};
use crate::error::{AppError, AppResult};

use super::dto::client_config;

/// 元数据请求超时。
pub(super) const META_TIMEOUT: Duration = Duration::from_secs(10);

/// producer 自己的重试窗口：超过它 librdkafka 就放弃这条消息并报 `MsgTimedOut`。
const PRODUCER_TIMEOUT: Duration = Duration::from_secs(40);

/// 发送一条消息时等 broker 确认的上限。
///
/// 必须**大于** `PRODUCER_TIMEOUT`：比它小的话，librdkafka 还在重试，这边已经
/// 先放手了 —— 用户看到「失败」，几秒后消息其实落了盘，再点一次就是重复。
pub(super) const DELIVERY_TIMEOUT: Duration = Duration::from_secs(45);

/// 发送队列里最多压多少条。面板是人工操作，队列满只说明 broker 连不上了。
const PRODUCER_QUEUE_CAPACITY: i32 = 10_000;

/// Kafka 客户端。
///
/// `BaseConsumer` 不是 `Sync`，因此内部统一用 `Arc` 包裹并在使用时独占访问。
pub struct KafkaClient {
    config: ClientConfig,
    bootstrap: String,
    admin: Arc<BaseConsumer>,
    /// 本连接唯一的 producer。
    ///
    /// 「每次发送新建一个 producer」看起来更干净，但它把幂等性彻底废掉了：
    /// `enable.idempotence` 的判重范围是**单个 producer 实例**（PID + epoch），
    /// 换实例就等于换了个身份，broker 无从判断这是不是同一条消息的重试。
    /// 而「点一次发送、超时、再点一次」恰好会吃到这一点：第一次真的写进去了，
    /// 第二次是另一个实例，于是日志里出现两条一模一样的内容。
    /// 常驻一个实例之后，幂等才是用户以为它一直在做的那个幂等。
    producer: Arc<Mutex<Option<FutureProducer>>>,
    /// 用户的高级选项把 producer 的哪些保证改掉了。
    ///
    /// 在 `connect()` 里算一次：librdkafka 遇到「开幂等但 acks=1」这类组合时
    /// 是**悄悄关掉幂等**，不报错也不警告，所以这件事必须由我们自己发现并说出来。
    guarantee: ProducerGuarantee,
    /// 已经警告过的那一轮的 `overridden`，避免同一次发送里连报两遍。
    warned: Arc<Mutex<bool>>,
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
        result.map_err(|error| {
            log::error!(target: "mqtui::kafka", "Kafka 元数据请求失败（{bootstrap}）：{error}");
            AppError::Connect(format!("{bootstrap}: {error}"))
        })?;
        log::info!(target: "mqtui::kafka", "Kafka 连接 {bootstrap} 成功，元数据可达");

        let guarantee = inspect_producer_options(&config.options);
        Ok(Self {
            config: base,
            bootstrap,
            admin,
            producer: Arc::new(Mutex::new(None)),
            guarantee,
            warned: Arc::new(Mutex::new(false)),
        })
    }

    /// 这条连接上的 producer 保证（幂等是否仍然生效）。
    pub fn guarantee(&self) -> &ProducerGuarantee {
        &self.guarantee
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

    /// 发送一条消息，返回「分区 / offset」或那张「不知道写没写进去」的告示。
    ///
    /// 第二条路径的返回值不是错误：`Err` 会让界面把它当成失败并鼓励再点一次，
    /// 而那正是重复消息的来源。它的措辞要求在 `DeliveryReceipt::Unsure` 上。
    pub async fn send(
        &self,
        topic: &str,
        key: Option<&str>,
        payload: &[u8],
        headers: &[MessageHeader],
    ) -> AppResult<DeliveryReceipt> {
        let headers = headers.iter().map(text_header).collect::<Vec<_>>();
        // 界面上填的 key 一定是文本，转成字节即可：`deliver` 只认字节。
        self.deliver(topic, key.map(str::as_bytes), payload, &headers)
            .await
    }

    /// 发送一条消息并返回落点。
    ///
    /// 与 `send` 的差别只在返回值形态：重发需要知道分区号才能判断
    /// 「同一条 key 有没有落到原来那个分区」，拼成字符串再解析回来很蠢。
    ///
    /// producer 是**本连接共用**的那一个（见 `producer_of`）：幂等只在单实例内生效，
    /// 每次新建等于每次都换个身份，`enable.idempotence` 就白写了。
    pub async fn deliver(
        &self,
        topic: &str,
        key: Option<&[u8]>,
        payload: &[u8],
        headers: &[RawMessageHeader],
    ) -> AppResult<DeliveryReceipt> {
        let producer = self.producer_of()?;

        let mut record = FutureRecord::<[u8], [u8]>::to(topic).payload(payload);
        if let Some(key) = key {
            record = record.key(key);
        }
        record = record.headers(owned_headers(headers));

        match producer
            .send(record, Timeout::After(DELIVERY_TIMEOUT))
            .await
        {
            Ok(delivery) => Ok(DeliveryReceipt::Written {
                partition: delivery.partition,
                offset: delivery.offset,
            }),
            Err((error, _)) => Ok(deliver_verdict(topic, &error)),
        }
    }

    /// 取本连接的 producer，没有就建一个。
    ///
    /// 建实例时要拿锁（`Client::from_config` 会设置日志队列），所以不在
    /// `&self` 的方法里常驻持锁 —— 只有第一次真正发送时才付这笔钱。
    fn producer_of(&self) -> AppResult<FutureProducer> {
        let mut slot = self
            .producer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(producer) = slot.as_ref() {
            return Ok(producer.clone());
        }

        let producer = producer_config(&self.config)
            .create::<FutureProducer>()
            .map_err(|error| AppError::Broker(format!("创建 Kafka 发送客户端失败: {error}")))?;
        *slot = Some(producer.clone());

        // 首次建 producer 时说一次，而不是每次发送都说：这是配置本身的问题，
        // 不是这一条消息的结论，重复报会变成噪音。
        let mut warned = self
            .warned
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*warned && let Some(warning) = self.guarantee.warning() {
            log::warn!(target: "mqtui::kafka", "{warning}");
            *warned = true;
        }

        Ok(producer)
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
            // 不共享父客户端的 producer：这个句柄多半要 `move` 进别的线程池，
            // 共享一个 sender 只会让「谁在发」更难说清。
            // 但警告要共享：同一个配置问题在一次操作里说两遍等于没说。
            guarantee: self.guarantee.clone(),
            producer: Arc::new(Mutex::new(None)),
            warned: Arc::clone(&self.warned),
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
            guarantee: inspect_producer_options(&config.options),
            config: base,
            bootstrap: config.brokers.join(","),
            admin: Arc::new(admin),
            producer: Arc::new(Mutex::new(None)),
            warned: Arc::new(Mutex::new(false)),
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

/// producer 配置：开启幂等，并把重试窗口放在 `DELIVERY_TIMEOUT` 之内。
///
/// 重试窗口比等待窗口长的话，「等待确认」先超时，而 librdkafka 还在后台重试 ——
/// 界面上是失败，日志里却写进去了。反过来留一段余量，连「放弃」的回执都等得到。
fn producer_config(base: &ClientConfig) -> ClientConfig {
    let mut config = base.clone();
    config
        .set("enable.idempotence", "true")
        // acks=all 与「单连接内最多 5 个未确认请求」都是幂等的前提，
        // 显式写出来免得被用户填的高级选项悄悄覆盖。
        .set("acks", "all")
        .set("max.in.flight.requests.per.connection", "5")
        .set(
            "message.timeout.ms",
            PRODUCER_TIMEOUT.as_millis().to_string(),
        )
        .set(
            "queue.buffering.max.messages",
            PRODUCER_QUEUE_CAPACITY.to_string(),
        );
    config
}

/// 投递失败时，这条消息到底写没写进去？
///
/// 只有两种情况能确定「没写」：压根没进队列（`QueueFull`），或者 producer
/// 是拿着 `acks=all` 等到了明确的拒绝。其余一律落到 `Unsure`——
/// 说「失败」会让人立刻再点一次，而重复消息正是这么来的。
fn deliver_verdict(topic: &str, error: &rdkafka::error::KafkaError) -> DeliveryReceipt {
    use rdkafka::error::KafkaError;
    use rdkafka::types::RDKafkaErrorCode as Code;

    let not_sent = match error {
        // 队列满 = 一条都没进 librdkafka 的队列。
        KafkaError::MessageProduction(Code::QueueFull) => {
            Some("发送队列已满，消息没有发出：稍后重试是安全的")
        }
        // 这两条由 producer 自己产生，说明消息在本地就被判定放弃了。
        KafkaError::MessageProduction(Code::MessageSizeTooLarge) => {
            Some("消息超过 broker 允许的大小，没有发出：改小之后再发是安全的")
        }
        KafkaError::MessageProduction(Code::InvalidMessage) => {
            Some("producer 判定这条消息不合法（key / payload 为空或 header 非法），没有发出")
        }
        _ => None,
    };

    match not_sent {
        Some(reason) => DeliveryReceipt::NotSent(reason.to_owned()),
        None => DeliveryReceipt::Unsure(format!(
            "等待 {topic} 的确认时出错（{error}）：消息可能已经写进去了。\
             先刷新看有没有，别直接再点一次——重发可能留下两条一样的消息"
        )),
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

/// 一次发送的结果。
///
/// 刻意做成三态而不是 `Result`：「写没写进去」和「有没有出错」不是同一件事。
/// `QueueFull` 是明确的没发出去，`MsgTimedOut` 是**不知道**，
/// 而后者被说成「失败」时，用户唯一会做的就是再点一次。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryReceipt {
    /// 确认落盘：分区 + offset。
    Written { partition: i32, offset: i64 },
    /// 确定没有写进日志，重试是安全的。里面是给人看的原因。
    NotSent(String),
    /// 不确定。措辞里必须包含「可能已写入」，并且不要鼓励重试。
    Unsure(String),
}

impl DeliveryReceipt {
    /// 给界面看的一句话。
    pub fn message(&self, topic: &str) -> String {
        match self {
            Self::Written { partition, offset } => {
                format!("已写入 {topic} 分区 {partition} offset {offset}")
            }
            Self::NotSent(reason) | Self::Unsure(reason) => reason.clone(),
        }
    }

    /// 落点。只有确认写入了才有。
    pub fn landed(&self) -> Option<(i32, i64)> {
        match *self {
            Self::Written { partition, offset } => Some((partition, offset)),
            _ => None,
        }
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use rdkafka::error::KafkaError;
    use rdkafka::types::RDKafkaErrorCode as Code;

    /// 只有「确定没发出去」的错误才允许被说成失败。
    /// 其余一律是「不知道」—— 说失败会让人再点一次，那才是重复消息的来源。
    #[test]
    fn queue_full_is_reported_as_not_sent() {
        let receipt = deliver_verdict("orders", &KafkaError::MessageProduction(Code::QueueFull));
        match receipt {
            DeliveryReceipt::NotSent(ref reason) => assert!(reason.contains("没有发出")),
            other => panic!("队列满应当是 NotSent，实际 {other:?}"),
        }
        assert_eq!(receipt.landed(), None);
    }

    #[test]
    fn timeout_is_reported_as_unsure() {
        let receipt = deliver_verdict(
            "orders",
            &KafkaError::MessageProduction(Code::MessageTimedOut),
        );
        match &receipt {
            DeliveryReceipt::Unsure(reason) => {
                // 措辞必须包含「可能已写入」，并且不能鼓励重试。
                assert!(reason.contains("可能已经写进去了"), "{reason}");
                assert!(reason.contains("别直接再点一次"), "{reason}");
            }
            other => panic!("超时应当是 Unsure，实际 {other:?}"),
        }
        assert_eq!(receipt.landed(), None);
    }

    #[test]
    fn oversized_message_is_not_retried_blindly() {
        let receipt = deliver_verdict(
            "orders",
            &KafkaError::MessageProduction(Code::MessageSizeTooLarge),
        );
        assert!(matches!(receipt, DeliveryReceipt::NotSent(_)));
    }

    /// 高级选项关掉幂等这件事，客户端要能自己发现。
    ///
    /// librdkafka 的处置是「安静地把 enable.idempotence 改回 false」，
    /// 所以这里不能指望建 producer 时报错。
    #[test]
    fn detached_client_reports_broken_idempotence() {
        let config = KafkaConfig {
            brokers: vec!["127.0.0.1:9092".to_owned()],
            tls: crate::domain::TlsMode::Disabled,
            auth: crate::domain::KafkaAuth {
                mechanism: crate::domain::SaslMechanism::None,
                username: String::new(),
                password: String::new(),
            },
            options: std::collections::BTreeMap::from([(
                "max.in.flight.requests.per.connection".to_owned(),
                "10".to_owned(),
            )]),
        };

        let client = KafkaClient::detached(&config).expect("构造客户端不该需要网络");
        let warning = client
            .guarantee()
            .warning()
            .expect("这一项会关掉幂等，必须给警告");
        assert!(warning.contains("幂等"), "{warning}");
    }

    #[test]
    fn detached_client_without_overrides_keeps_idempotence() {
        let config = KafkaConfig {
            brokers: vec!["127.0.0.1:9092".to_owned()],
            tls: crate::domain::TlsMode::Disabled,
            auth: crate::domain::KafkaAuth {
                mechanism: crate::domain::SaslMechanism::None,
                username: String::new(),
                password: String::new(),
            },
            options: std::collections::BTreeMap::new(),
        };

        let client = KafkaClient::detached(&config).expect("构造客户端不该需要网络");
        assert_eq!(client.guarantee().warning(), None);
    }

    /// 生产者配置里这几项互为前提：少一项，幂等就只是个名字。
    #[test]
    fn producer_config_enables_idempotence_within_delivery_timeout() {
        let config = producer_config(&ClientConfig::new());
        assert_eq!(config.get("enable.idempotence"), Some("true"));
        assert_eq!(config.get("acks"), Some("all"));
        assert_eq!(
            config.get("max.in.flight.requests.per.connection"),
            Some("5")
        );

        // 重试窗口必须落在等待窗口之内：比它长的话，这边先超时、librdkafka 还在后台重试。
        let budget: u128 = config
            .get("message.timeout.ms")
            .and_then(|value| value.parse().ok())
            .expect("必须显式写死重试窗口");
        assert!(budget < DELIVERY_TIMEOUT.as_millis());
    }
}
