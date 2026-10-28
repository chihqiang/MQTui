//! 连接相关的领域模型。
//!
//! 前端类型定义见 `src/types/broker.ts`，字段命名使用 camelCase 以贴合前端习惯。

use serde::{Deserialize, Serialize};

/// 支持的中间件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrokerKind {
    Kafka,
    RabbitMq,
}

impl BrokerKind {
    /// 前端展示用的默认名称。
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Kafka => "Kafka",
            Self::RabbitMq => "RabbitMQ",
        }
    }

    /// 该中间件支持的面板能力，前端据此决定菜单结构。
    pub const fn capabilities(self) -> &'static [BrokerCapability] {
        match self {
            Self::Kafka => &[
                BrokerCapability::Overview,
                BrokerCapability::Cluster,
                BrokerCapability::Topics,
                BrokerCapability::ConsumerGroups,
                BrokerCapability::OffsetReset,
                BrokerCapability::OrphanTopics,
                BrokerCapability::Access,
                BrokerCapability::Messages,
                BrokerCapability::Produce,
            ],
            Self::RabbitMq => &[
                BrokerCapability::Overview,
                BrokerCapability::Cluster,
                BrokerCapability::Runtime,
                BrokerCapability::Queues,
                BrokerCapability::Admin,
                BrokerCapability::Policies,
                BrokerCapability::Parameters,
                BrokerCapability::Exchanges,
                BrokerCapability::Consumers,
                BrokerCapability::ConsumerOwnership,
                BrokerCapability::Routing,
                BrokerCapability::TopologyGraph,
                BrokerCapability::ConsumerGraph,
                BrokerCapability::Messages,
                BrokerCapability::Produce,
            ],
        }
    }
}

/// 面板能力枚举。前端用它拼装菜单，避免为 Kafka / RabbitMQ 写两套硬编码菜单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrokerCapability {
    /// 概览信息（集群、节点、版本等）。
    Overview,
    /// 集群视图：节点列表、存活状态与一致性报警。Kafka 与 RabbitMQ 都提供。
    Cluster,
    /// RabbitMQ 运行时：套接字连接、通道与队列位置。
    Runtime,
    /// Kafka 主题列表。
    Topics,
    /// Kafka 消费组列表与滞后量。
    ConsumerGroups,
    /// Kafka 消费组位点重置：预览对照表后按计划提交。
    ///
    /// 只有 Kafka 有这个概念（RabbitMQ 的队列没有「分区位点」可改），
    /// 所以它必须是 Kafka 声明的 —— 否则路由和页面都在，菜单里却看不见。
    OffsetReset,
    /// Kafka 无消费组主题：没有消费组在消费、消息仍在堆积的主题。
    OrphanTopics,
    /// RabbitMQ 队列列表。
    Queues,
    /// Kafka 准入：客户端配额与 SASL/SCRAM 凭据。
    ///
    /// 只有 Kafka 有这套东西 —— RabbitMQ 的账号与权限是另一回事（在 `Admin` 里）。
    /// 这一页只读：librdkafka 既没导出 `DescribeClientQuotas`，
    /// 也没导出 `AlterUserScramCredentials`。
    Access,
    /// RabbitMQ 账户管理：vhost、用户、权限。
    ///
    /// 三样都挂在管理 HTTP API 上（`/api/vhosts`、`/api/users`、`/api/permissions`），
    /// AMQP 协议本身没有这些概念 —— 所以未配置管理地址时这一页会直接报错，
    /// 而不是给一个空列表。
    Admin,
    /// RabbitMQ 策略与操作员策略：TTL、死信、长度上限、镜像。
    Policies,
    /// RabbitMQ 参数：联邦（federation）、铲子（shovel）与运行时参数。
    Parameters,
    /// RabbitMQ 交换机与绑定关系（依赖管理 HTTP API）。
    Exchanges,
    /// RabbitMQ 消费者连线：每个队列被谁消费、预取与未确认情况。
    Consumers,
    /// RabbitMQ 消费者归属：把消费者挂回「哪条连接、哪个账号、哪个对端地址」。
    ///
    /// 与 `Consumers` 是两个问题：那条回答「有几个消费者」，这条回答
    /// 「这条连接到底占了什么」。断开消费者时后者才是要看的。
    ConsumerOwnership,
    /// RabbitMQ 路由估算：交换机到队列的可达性与死路排查。
    Routing,
    /// RabbitMQ 拓扑图：交换机与队列的分层布局。
    TopologyGraph,
    /// RabbitMQ 消费者连线图：交换机 → 队列 → 消费者连接的整条链路。
    ConsumerGraph,
    /// 消息浏览与详情。
    Messages,
    /// 消息发送。
    Produce,
}

/// 连接的唯一标识，由后端在建立连接时生成。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectionId(pub String);

impl ConnectionId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl Default for ConnectionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ConnectionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// TLS 启用模式。Kafka 与 RabbitMQ 的语义不同，但对外保持同一套取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TlsMode {
    /// 不启用 TLS。
    #[default]
    Disabled,
    /// 先明文后 TLS（RabbitMQ 的 STARTTLS 语义），Kafka 下等同 Disabled。
    Optional,
    /// 强制 TLS。
    Required,
}

/// SASL 认证机制，取值对应 Kafka 的 `sasl.mechanism`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaslMechanism {
    /// 不启用 SASL。
    #[default]
    None,
    Plain,
    ScramSha256,
    ScramSha512,
}

impl SaslMechanism {
    /// 对应 rdkafka 的 `sasl.mechanism` 取值；`None` 表示不配置。
    pub const fn as_kafka_str(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Plain => Some("PLAIN"),
            Self::ScramSha256 => Some("SCRAM-SHA-256"),
            Self::ScramSha512 => Some("SCRAM-SHA-512"),
        }
    }
}

/// Kafka 认证配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaAuth {
    pub mechanism: SaslMechanism,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
}

/// Kafka 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConfig {
    /// `host:port` 列表，例如 `["127.0.0.1:9092"]`。
    pub brokers: Vec<String>,
    #[serde(default)]
    pub tls: TlsMode,
    #[serde(default)]
    pub auth: KafkaAuth,
    /// 附加的 librdkafka 配置项，键值原样透传。
    #[serde(default)]
    pub options: std::collections::BTreeMap<String, String>,
}

/// RabbitMQ 认证配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RabbitMqAuth {
    pub username: String,
    pub password: String,
    /// 虚拟主机。
    #[serde(default = "default_vhost")]
    pub vhost: String,
}

fn default_vhost() -> String {
    "/".to_owned()
}

impl Default for RabbitMqAuth {
    fn default() -> Self {
        Self {
            username: "guest".to_owned(),
            password: "guest".to_owned(),
            vhost: default_vhost(),
        }
    }
}

/// RabbitMQ 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RabbitMqConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub tls: TlsMode,
    #[serde(default)]
    pub auth: RabbitMqAuth,
    /// 管理插件地址（如 `http://localhost:15672`）。
    ///
    /// AMQP 协议无法枚举队列，队列列表只能靠管理 HTTP API。它**不是可选项**：
    /// 队列、交换机、绑定、策略、参数、消费者、运行时、拓扑图全都压在它上面。
    /// 所以留空不等于「这个能力关了」，而是「按 host + TLS 推出的那一个」
    /// （见 `resolved_management_url`）；只有显式写了个空串才真的关掉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub management_url: Option<String>,
}

/// 管理 API 的两个默认端口。15672 是管理插件明文端口，15671 是它配 TLS 时的端口。
pub const DEFAULT_MANAGEMENT_HTTP_PORT: u16 = 15672;
pub const DEFAULT_MANAGEMENT_HTTPS_PORT: u16 = 15671;

impl RabbitMqConfig {
    /// 管理 API 的实际地址。
    ///
    /// 三句话说完规则：
    /// - 写了就按写的用（去掉尾部斜杠），用户能从面板里改，就别再猜第二次；
    /// - 空串是显式的「不用管理插件」，老前端发 `""` 的语义不变；
    /// - `None` 才是最省事的那个分支：按 AMQP 用的 host 推出来。TLS 连接对应
    ///   `https` + 15671，否则 `http` + 15672 —— 与本机的默认配置一致。
    ///
    /// 注意 `port` 不参与推导：AMQP 的 5672 管理插件不认，15672 也不是它。
    pub fn resolved_management_url(&self) -> Option<String> {
        match self.management_url.as_deref() {
            None => Some(self.inferred_management_url()),
            Some(url) => {
                let trimmed = url.trim().trim_end_matches('/');
                (!trimmed.is_empty()).then(|| trimmed.to_owned())
            }
        }
    }

    /// 按 host 与 TLS 模式推出管理 API 地址（不看已填的值）。
    pub fn inferred_management_url(&self) -> String {
        let (scheme, port) = match self.tls {
            TlsMode::Disabled => ("http", DEFAULT_MANAGEMENT_HTTP_PORT),
            TlsMode::Optional | TlsMode::Required => ("https", DEFAULT_MANAGEMENT_HTTPS_PORT),
        };
        format!("{scheme}://{}:{port}", self.host.trim())
    }

    /// 把空着的那一格补上。**不动**已填的和显式关掉的。
    ///
    /// 存盘与重连走的是这一版：界面上一眼能看到的地址，就是实际会用的地址，
    /// 不必等第一次请求 15672 失败才发现它根本没配。
    pub fn with_inferred_management_url(mut self) -> Self {
        if self.management_url.is_none() {
            self.management_url = Some(self.inferred_management_url());
        }
        self
    }
}

/// 创建连接的入参。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectionConfig {
    Kafka(KafkaConfig),
    RabbitMq(RabbitMqConfig),
}

impl ConnectionConfig {
    pub const fn kind(&self) -> BrokerKind {
        match self {
            Self::Kafka(_) => BrokerKind::Kafka,
            Self::RabbitMq(_) => BrokerKind::RabbitMq,
        }
    }

    /// 用于列表展示的连接地址描述。
    pub fn endpoint(&self) -> String {
        match self {
            Self::Kafka(config) => config.brokers.join(","),
            Self::RabbitMq(config) => format!("{}:{}", config.host, config.port),
        }
    }

    /// 基础校验，尽早失败并返回可直接展示给用户的提示。
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Kafka(config) if config.brokers.is_empty() => {
                Err("Kafka 至少需要一个 broker 地址".to_owned())
            }
            Self::RabbitMq(config) if config.host.trim().is_empty() => {
                Err("RabbitMQ host 不能为空".to_owned())
            }
            _ => Ok(()),
        }
    }
}

/// 连接列表项。`active` 表示连接当前可用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: ConnectionId,
    pub name: String,
    pub kind: BrokerKind,
    pub endpoint: String,
    pub active: bool,
}

/// 概览中的一条键值信息，避免为不同中间件写不同的结构体。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub title: String,
    pub items: Vec<KeyValue>,
}

/// 通用的键值对。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    /// 展示用的值：字符串去引号，其余按 JSON 形态。
    pub value: String,
    /// 值是字符串字面量。缺省为 `true`。
    ///
    /// 服务端的值有类型（数字、布尔、嵌套表），而这里只保留了它的渲染形态。
    /// 少一个类型标记，`render_json("3")` 与 `render_json(3)` 就长得一模一样，
    /// 而「拿字符串去比数字」比出来的结论是猜的。
    #[serde(default = "default_text_value")]
    pub text: bool,
}

fn default_text_value() -> bool {
    true
}

impl KeyValue {
    /// 值来自一段文本。
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
            text: true,
        }
    }

    /// 值不是字符串字面量：数字、布尔、嵌套表、数组、null。
    pub fn typed(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
            text: false,
        }
    }
}

/// Kafka 主题信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicInfo {
    pub name: String,
    pub partitions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replication_factor: Option<usize>,
    /// 内部主题（`__consumer_offsets` 等）。界面上不该给删除 / 扩容入口。
    #[serde(default)]
    pub internal: bool,
}

/// RabbitMQ 队列信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueInfo {
    pub name: String,
    pub vhost: String,
    /// 消费者数量。
    pub consumers: u32,
    /// 队列中的消息数，仅管理 API 能提供（AMQP 协议本身查不到）。
    #[serde(default)]
    pub messages: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_serialize_as_camel_case() {
        let json = serde_json::to_string(&BrokerKind::RabbitMq).expect("序列化失败");
        assert_eq!(json, "\"rabbitMq\"");
    }

    fn rabbit(host: &str, tls: TlsMode, management_url: Option<&str>) -> RabbitMqConfig {
        RabbitMqConfig {
            host: host.to_owned(),
            port: 5672,
            tls,
            auth: RabbitMqAuth::default(),
            management_url: management_url.map(str::to_owned),
        }
    }

    #[test]
    fn missing_management_url_is_derived_from_host() {
        // 没填 = 按 host 推一个，不是「这个能力关了」。
        assert_eq!(
            rabbit("mq.example.com", TlsMode::Disabled, None).resolved_management_url(),
            Some("http://mq.example.com:15672".to_owned())
        );
        assert_eq!(
            rabbit("mq.example.com", TlsMode::Required, None).resolved_management_url(),
            Some("https://mq.example.com:15671".to_owned())
        );
    }

    #[test]
    fn typed_management_url_wins_over_derivation() {
        // 反代、跳板、别的端口都在这一种里：写了的为准，尾部斜杠顺手去掉。
        assert_eq!(
            rabbit("mq", TlsMode::Disabled, Some(" https://gw.internal/mq/ "))
                .resolved_management_url(),
            Some("https://gw.internal/mq".to_owned())
        );
    }

    #[test]
    fn empty_management_url_turns_the_capability_off() {
        // 空串是显式的「不用管理插件」，与没填区分开。
        assert_eq!(
            rabbit("mq", TlsMode::Disabled, Some("  ")).resolved_management_url(),
            None
        );
    }

    #[test]
    fn inferred_url_is_filled_in_only_when_absent() {
        let filled = rabbit("mq", TlsMode::Disabled, None).with_inferred_management_url();
        assert_eq!(filled.management_url.as_deref(), Some("http://mq:15672"));

        let kept = rabbit("mq", TlsMode::Disabled, Some("https://gw.internal"))
            .with_inferred_management_url();
        assert_eq!(kept.management_url.as_deref(), Some("https://gw.internal"));

        let off = rabbit("mq", TlsMode::Disabled, Some("")).with_inferred_management_url();
        assert_eq!(off.management_url.as_deref(), Some(""));
    }

    #[test]
    fn rabbitmq_declares_exchanges_but_kafka_does_not() {
        assert!(
            BrokerKind::RabbitMq
                .capabilities()
                .contains(&BrokerCapability::Exchanges)
        );
        assert!(
            !BrokerKind::Kafka
                .capabilities()
                .contains(&BrokerCapability::Exchanges)
        );
        assert!(
            BrokerKind::Kafka
                .capabilities()
                .contains(&BrokerCapability::OrphanTopics)
        );
    }

    #[test]
    fn both_kinds_expose_a_cluster_page() {
        for kind in [BrokerKind::Kafka, BrokerKind::RabbitMq] {
            assert!(
                kind.capabilities().contains(&BrokerCapability::Cluster),
                "{kind:?} 缺少集群页"
            );
        }
    }

    #[test]
    fn runtime_page_is_rabbitmq_only() {
        assert!(
            BrokerKind::RabbitMq
                .capabilities()
                .contains(&BrokerCapability::Runtime)
        );
        assert!(
            !BrokerKind::Kafka
                .capabilities()
                .contains(&BrokerCapability::Runtime)
        );
    }

    /// 每个能力变体的用途说明。
    ///
    /// 这里的 `match` 是**穷举**的：`BrokerCapability` 新增一个变体却忘了在下面
    /// 登记，这段代码就编译不过。守卫测试因此不需要「记得更新」——
    /// 编译器会先替你记得。
    const fn capability_note(capability: BrokerCapability) -> &'static str {
        match capability {
            BrokerCapability::Overview => "概览",
            BrokerCapability::Cluster => "集群",
            BrokerCapability::Runtime => "运行时连接",
            BrokerCapability::Topics => "主题",
            BrokerCapability::ConsumerGroups => "消费组",
            BrokerCapability::OffsetReset => "位点重置",
            BrokerCapability::OrphanTopics => "无消费组主题",
            BrokerCapability::Queues => "队列",
            BrokerCapability::Access => "准入",
            BrokerCapability::Admin => "账户",
            BrokerCapability::Policies => "策略",
            BrokerCapability::Parameters => "参数",
            BrokerCapability::Exchanges => "交换机",
            BrokerCapability::Consumers => "消费者",
            BrokerCapability::ConsumerOwnership => "消费归属",
            BrokerCapability::Routing => "路由估算",
            BrokerCapability::TopologyGraph => "拓扑图",
            BrokerCapability::ConsumerGraph => "消费链路",
            BrokerCapability::Messages => "消息",
            BrokerCapability::Produce => "发送消息",
        }
    }

    /// 全部能力，顺序不影响断言。
    const ALL_CAPABILITIES: &[BrokerCapability] = &[
        BrokerCapability::Overview,
        BrokerCapability::Cluster,
        BrokerCapability::Runtime,
        BrokerCapability::Topics,
        BrokerCapability::ConsumerGroups,
        BrokerCapability::OffsetReset,
        BrokerCapability::OrphanTopics,
        BrokerCapability::Queues,
        BrokerCapability::Access,
        BrokerCapability::Admin,
        BrokerCapability::Policies,
        BrokerCapability::Parameters,
        BrokerCapability::Exchanges,
        BrokerCapability::Consumers,
        BrokerCapability::ConsumerOwnership,
        BrokerCapability::Routing,
        BrokerCapability::TopologyGraph,
        BrokerCapability::ConsumerGraph,
        BrokerCapability::Messages,
        BrokerCapability::Produce,
    ];

    #[test]
    fn every_capability_is_declared_by_some_kind() {
        // 「写了没接上」的漏就是这么来的：路由、页面、后端命令都齐了，
        // 但没人在 `capabilities()` 里声明，菜单里就永远看不见它。
        for &capability in ALL_CAPABILITIES {
            let declared = [BrokerKind::Kafka, BrokerKind::RabbitMq]
                .iter()
                .any(|kind| kind.capabilities().contains(&capability));
            assert!(
                declared,
                "{}（{capability:?}）没有任何中间件声明，前端菜单里会看不见它",
                capability_note(capability)
            );
        }
    }

    #[test]
    fn no_kind_declares_a_capability_twice() {
        // 重复声明会让前端菜单出现两个同名入口。
        for kind in [BrokerKind::Kafka, BrokerKind::RabbitMq] {
            let mut seen = std::collections::HashSet::new();
            for &capability in kind.capabilities() {
                assert!(
                    seen.insert(capability),
                    "{kind:?} 重复声明了 {}（{capability:?}）",
                    capability_note(capability)
                );
            }
        }
    }

    #[test]
    fn access_page_is_kafka_only() {
        // 配额与 SCRAM 是 Kafka 自己的概念。RabbitMQ 的账号权限在 `Admin` 里，
        // 声明 `Access` 会让 RabbitMQ 菜单里多出一个永远报错的入口。
        assert!(
            BrokerKind::Kafka
                .capabilities()
                .contains(&BrokerCapability::Access)
        );
        assert!(
            !BrokerKind::RabbitMq
                .capabilities()
                .contains(&BrokerCapability::Access)
        );
    }

    #[test]
    fn admin_page_is_rabbitmq_only() {
        // vhost / 用户 / 权限只存在于管理 HTTP API 上，Kafka 声明它就是骗人。
        assert!(
            BrokerKind::RabbitMq
                .capabilities()
                .contains(&BrokerCapability::Admin)
        );
        assert!(
            !BrokerKind::Kafka
                .capabilities()
                .contains(&BrokerCapability::Admin)
        );
    }

    #[test]
    fn offset_reset_is_kafka_only() {
        // 位点重置走 `as_kafka()?`，RabbitMQ 声明它就是骗人：菜单点进去只会报错。
        assert!(
            BrokerKind::Kafka
                .capabilities()
                .contains(&BrokerCapability::OffsetReset)
        );
        assert!(
            !BrokerKind::RabbitMq
                .capabilities()
                .contains(&BrokerCapability::OffsetReset)
        );
    }

    #[test]
    fn every_kind_has_capabilities() {
        for kind in [BrokerKind::Kafka, BrokerKind::RabbitMq] {
            assert!(!kind.capabilities().is_empty(), "{kind:?} 缺少能力声明");
        }
    }

    #[test]
    fn connection_config_is_adjacently_tagged() {
        let config = ConnectionConfig::RabbitMq(RabbitMqConfig {
            host: "localhost".to_owned(),
            port: 5672,
            tls: TlsMode::Disabled,
            auth: RabbitMqAuth::default(),
            management_url: None,
        });
        let json = serde_json::to_value(&config).expect("序列化失败");
        assert_eq!(json["kind"], "rabbitMq");
        assert_eq!(json["auth"]["vhost"], "/");
    }
}
