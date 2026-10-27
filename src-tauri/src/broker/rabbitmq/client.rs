//! RabbitMQ 客户端封装。

use std::sync::Arc;

use lapin::options::{BasicGetOptions, BasicPublishOptions, BasicRejectOptions};
use lapin::types::ShortString;
use lapin::{BasicProperties, Connection, ConnectionProperties};

use crate::domain::{
    BindingKey, BindingSpec, CheckStatus, ExchangeRemoval, ExchangeSpec, HealthCheck, HealthReport,
    KeyValue, Overview, QueueDetail, QueueInfo, RabbitMqConfig, RabbitMqTopology, WRITE_ACCESS_KEY,
};
use crate::error::{AppError, AppResult};

use super::dto::{amqp_uri, field_table_from_headers};
use super::management::ManagementClient;

/// 单条消息的原始形态，交给 message 模块做领域建模。
pub struct RawDelivery {
    pub queue: String,
    pub exchange: String,
    pub routing_key: String,
    pub delivery_tag: u64,
    pub redelivered: bool,
    pub properties: BasicProperties,
    pub payload: Vec<u8>,
}

/// RabbitMQ 客户端。
pub struct RabbitMqClient {
    connection: Arc<Connection>,
    /// 连接配置，队列查询需要复用其中的凭据与管理地址。
    config: RabbitMqConfig,
    /// 管理 API 客户端；未配置管理地址时为 `None`，队列列表能力随之不可用。
    management: Option<ManagementClient>,
}

impl RabbitMqClient {
    /// 建立 AMQP 连接。`lapin` 自身带自动重连，面板侧只需验证首次握手成功。
    pub async fn connect(config: RabbitMqConfig) -> AppResult<Self> {
        let endpoint = format!("{}:{}", config.host, config.port);
        let connection = Connection::connect(&amqp_uri(&config), ConnectionProperties::default())
            .await
            .map_err(|error| AppError::Connect(format!("{endpoint}: {error}")))?;
        let management = ManagementClient::from_config(&config)?;

        Ok(Self {
            connection: Arc::new(connection),
            config,
            management,
        })
    }

    /// 概览信息。
    ///
    /// AMQP 协议本身不提供集群管理接口（queues 列表、节点信息需要 HTTP 管理插件），
    /// 因此这里只展示连接维度的信息，队列列表需要用户主动声明队列名。
    pub async fn overview(&self) -> AppResult<Overview> {
        let items = vec![
            KeyValue::new(
                "Endpoint",
                format!("{}:{}", self.config.host, self.config.port),
            ),
            KeyValue::new("Virtual Host", self.config.auth.vhost.clone()),
            KeyValue::new(
                "连接状态",
                if self.connection.status().connected() {
                    "已连接"
                } else {
                    "断开"
                },
            ),
            KeyValue::new(
                "管理 API",
                self.management
                    .as_ref()
                    .map(|client| client.base_url().to_owned())
                    .unwrap_or_else(|| "未配置（队列列表不可用）".to_owned()),
            ),
        ];
        Ok(Overview {
            title: "RabbitMQ 节点".to_owned(),
            items,
        })
    }

    /// 列出队列。
    ///
    /// AMQP 0-9-1 不提供队列枚举接口，只能走管理插件 HTTP API。
    /// 未配置管理地址时返回空列表（前端会提示手动输入队列名），
    /// 配置了但请求失败时把错误抛给上层，方便用户排查。
    pub async fn queues(&self) -> AppResult<Vec<QueueInfo>> {
        let Some(management) = &self.management else {
            return Ok(Vec::new());
        };
        management.queues(&self.config).await
    }

    /// 拓扑快照：交换机 + 绑定 + 队列。
    ///
    /// 三个接口串行请求而非并发：管理插件对并发请求很敏感（尤其是队列多的时候），
    /// 面板属于交互式工具，多花几十毫秒换服务端压力更划算。
    /// 未配置管理地址时返回空快照，队列列表本就不该有内容，交换机与绑定同样查不到。
    pub async fn topology(&self) -> AppResult<RabbitMqTopology> {
        let Some(management) = &self.management else {
            return Ok(RabbitMqTopology {
                exchanges: Vec::new(),
                bindings: Vec::new(),
                queues: Vec::new(),
            });
        };

        Ok(RabbitMqTopology {
            exchanges: management.exchanges(&self.config).await?,
            bindings: management.bindings(&self.config).await?,
            queues: management.queues(&self.config).await?,
        })
    }

    /// 拉取队列中的消息。
    ///
    /// 用 `basic.reject(requeue=true)` 把消息放回队列：面板只是「看一眼」，
    /// 不能因为查看动作让消息从队列里消失。代价是同一条消息会被反复读到，
    /// 所以这里只取一次，由上层按需去重。
    pub async fn get_messages(&self, queue: &str, limit: usize) -> AppResult<Vec<RawDelivery>> {
        let channel = self.channel().await?;
        let mut deliveries = Vec::with_capacity(limit);

        for _ in 0..limit {
            let Some(delivery) = channel
                .basic_get(
                    ShortString::from(queue.to_owned()),
                    BasicGetOptions { no_ack: false },
                )
                .await
                .map_err(AppError::from)?
            else {
                break;
            };

            deliveries.push(RawDelivery {
                queue: queue.to_owned(),
                exchange: delivery.exchange.to_string(),
                routing_key: delivery.routing_key.to_string(),
                delivery_tag: delivery.delivery_tag,
                redelivered: delivery.redelivered,
                properties: delivery.properties.clone(),
                payload: delivery.data.clone(),
            });

            // 读后立即放回队列，保证查看行为无副作用。
            channel
                .basic_reject(delivery.delivery_tag, BasicRejectOptions { requeue: true })
                .await
                .map_err(AppError::from)?;
        }

        Ok(deliveries)
    }

    /// 发布消息到交换机。
    pub async fn publish(
        &self,
        exchange: &str,
        routing_key: &str,
        payload: &[u8],
        headers: &[(String, String)],
    ) -> AppResult<String> {
        let channel = self.channel().await?;
        let properties = BasicProperties::default()
            .with_content_type("text/plain".into())
            .with_headers(field_table_from_headers(headers));

        let confirmation = channel
            .basic_publish(
                ShortString::from(exchange.to_owned()),
                ShortString::from(routing_key.to_owned()),
                BasicPublishOptions::default(),
                payload,
                properties,
            )
            .await
            .map_err(AppError::from)?
            .await
            .map_err(AppError::from)?;

        Ok(format!(
            "exchange={exchange} routing_key={routing_key} ack={confirmation:?}"
        ))
    }

    /// 健康检查：AMQP 握手状态 + 管理 API 可达性 + 写权限。
    ///
    /// 三项分开报告而不是合并成一个布尔值：面板需要区分「连不上」
    /// 和「连上了但看不了队列」，前者要重连，后者只是少个功能。
    pub async fn health(&self) -> AppResult<HealthReport> {
        let mut items = vec![self.amqp_check()];

        match &self.management {
            Some(management) => {
                items.push(match management.queues(&self.config).await {
                    Ok(queues) => HealthCheck::new("management", "管理 API", CheckStatus::Ok)
                        .with_detail(format!("{} 个队列", queues.len())),
                    Err(error) => HealthCheck::new("management", "管理 API", CheckStatus::Failed)
                        .with_detail(error.to_string()),
                });
                items.push(
                    management
                        .write_check(&self.config)
                        .await
                        .unwrap_or_else(|error| {
                            HealthCheck::new(
                                WRITE_ACCESS_KEY,
                                "管理 API 写权限",
                                CheckStatus::Unknown,
                            )
                            .with_detail(error.to_string())
                        }),
                );
            }
            None => {
                items.push(
                    HealthCheck::new("management", "管理 API", CheckStatus::Unknown)
                        .with_detail("未配置管理地址，队列列表与写操作不可用"),
                );
                items.push(
                    HealthCheck::new(WRITE_ACCESS_KEY, "管理 API 写权限", CheckStatus::Unknown)
                        .with_detail("未配置管理地址"),
                );
            }
        }

        Ok(HealthReport {
            items,
            checked_at: now_millis(),
        })
    }

    /// 读取单个队列的详情。
    pub async fn queue_detail(&self, queue: &str) -> AppResult<QueueDetail> {
        self.management()?.queue_detail(&self.config, queue).await
    }

    /// 清空队列中的消息（保留队列）。
    pub async fn purge_queue(&self, queue: &str) -> AppResult<()> {
        self.management()?.purge_queue(&self.config, queue).await
    }

    /// 删除队列。队列非空时服务端会拒绝，错误信息直接透出。
    pub async fn delete_queue(&self, queue: &str) -> AppResult<()> {
        self.management()?.delete_queue(&self.config, queue).await
    }

    /// 新建交换机。
    pub async fn create_exchange(&self, spec: &ExchangeSpec) -> AppResult<()> {
        spec.validate().map_err(AppError::Invalid)?;
        self.management()?.create_exchange(&self.config, spec).await
    }

    /// 删除交换机。
    ///
    /// `internal` 由调用方从拓扑快照里带过来，本地先按服务端约束拦一遍：
    /// 默认交换机、`amq.` 保留命名、`internal` 交换机在界面上根本不该出现删除按钮。
    pub async fn delete_exchange(&self, name: &str, internal: bool) -> AppResult<()> {
        if let Some(reason) = ExchangeRemoval::evaluate(name, internal).reason() {
            return Err(AppError::Invalid(reason.to_owned()));
        }
        self.management()?.delete_exchange(&self.config, name).await
    }

    /// 新建绑定。源交换机与目标存在性交给服务端校验，本地只挡空值这类显然的错误。
    pub async fn create_binding(&self, spec: &BindingSpec) -> AppResult<()> {
        spec.validate().map_err(AppError::Invalid)?;
        self.management()?.create_binding(&self.config, spec).await
    }

    /// 删除绑定。默认交换机上的绑定由服务端隐式维护，不允许单独删除。
    pub async fn delete_binding(&self, key: &BindingKey) -> AppResult<()> {
        if key.is_default_exchange() {
            return Err(AppError::Invalid(
                "默认交换机的绑定由服务端隐式维护，不能单独删除".to_owned(),
            ));
        }
        self.management()?.delete_binding(&self.config, key).await
    }

    /// 取管理 API 客户端，未配置时给出统一的引导文案。
    fn management(&self) -> AppResult<&ManagementClient> {
        self.management.as_ref().ok_or_else(|| {
            AppError::Unsupported(
                "该操作依赖 RabbitMQ 管理插件，请在连接配置里填写管理 API 地址".to_owned(),
            )
        })
    }

    /// AMQP 连接状态。`lapin` 自带重连，这里只报告当下是否连上。
    fn amqp_check(&self) -> HealthCheck {
        let connected = self.connection.status().connected();
        HealthCheck::new("amqp", "AMQP 连接", CheckStatus::from_bool(connected)).with_detail(
            format!(
                "{}:{} / vhost {}",
                self.config.host, self.config.port, self.config.auth.vhost
            ),
        )
    }

    async fn channel(&self) -> AppResult<lapin::Channel> {
        self.connection
            .create_channel()
            .await
            .map_err(AppError::from)
    }
}

/// 毫秒时间戳。健康报告要展示「几秒前探测的」，因此统一用毫秒。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}
