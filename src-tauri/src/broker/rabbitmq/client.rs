//! RabbitMQ 客户端封装。

use std::sync::Arc;

use lapin::options::{BasicGetOptions, BasicPublishOptions, BasicRejectOptions};
use lapin::types::ShortString;
use lapin::{BasicProperties, Connection, ConnectionProperties};

use crate::domain::{
    BindingKey, BindingSpec, CheckStatus, ConsumerGraph, ConsumerLinks, ExchangeRemoval,
    ExchangeSpec, HealthCheck, HealthReport, KeyValue, MessageHeader, Overview, ParameterComponent,
    ParameterSnapshot, PolicySnapshot, PolicySpec, QueueDetail, QueueInfo, RabbitMqConfig,
    RabbitMqTopology, SendRoute, TopologyGraph, TopologyInsight, WRITE_ACCESS_KEY,
    analyze_topology, build_consumer_graph, build_topology_graph, predict_send_route,
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

    /// 连接配置。运行时聚合需要复用其中的 vhost 与凭据。
    pub fn config(&self) -> &RabbitMqConfig {
        &self.config
    }

    /// 概览信息。
    ///
    /// AMQP 协议本身不提供集群管理接口（queues 列表、节点信息需要 HTTP 管理插件），
    /// 因此这里只展示连接维度的信息，队列列表需要用户主动声明队列名。
    pub async fn overview(&self) -> AppResult<Overview> {
        let mut items = vec![
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
        // 队列位置与节点指标都是「顺手能看到的最有价值的东西」：
        // 概览页把总数写出来，用户就不用先点进集群页再回来。
        if let Some(management) = &self.management
            && let Ok(nodes) = management
                .nodes_payload::<Vec<serde_json::Value>>(self)
                .await
        {
            items.push(KeyValue::new("节点数", nodes.len().to_string()));
        }

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

    /// 拓扑图：交换机与队列的分层布局 + 连线。
    ///
    /// 与 `topology` 的差别是「谁算层级」：布局规则（环怎么截断、同名怎么区分）
    /// 是纯逻辑，放在 `domain::topology_graph` 里脱库单测；这里只负责取数。
    /// 数据快照与 `topology` 共用，保证图上的线和列表里的绑定是同一批。
    pub async fn topology_graph(&self) -> AppResult<TopologyGraph> {
        Ok(build_topology_graph(&self.topology().await?))
    }

    /// 消费者连线图：交换机 → 队列 → 消费者连接。
    ///
    /// 三份数据必须来自同一时刻：拓扑决定「消息从哪来」，连线决定「被谁拿走」，
    /// 分开取会出现「这条连接已经断了，图上还在连」的错觉。
    /// 消费者列表在权限受限的账号上会 403，这时降级为空 —— 图退化成只有上游半张，
    /// 但仍然比整页报错有用。
    pub async fn consumer_graph(&self) -> AppResult<ConsumerGraph> {
        let topology = self.topology().await?;
        let links = self.consumer_links().await?;
        Ok(build_consumer_graph(&topology, &links))
    }

    /// 交换机到队列的路由估算。
    ///
    /// 交换机、绑定、队列速率分属三个接口，但结论必须建立在同一份快照上：
    /// 分开取会出现「绑定刚删掉、速率还是删之前」的自相矛盾。
    /// 队列速率是可选的——没有管理 API 或该账号看不到 stats 时，
    /// 路由结论照旧，只是少了「队列堆积但没人消费」这一条。
    pub async fn topology_insight(&self) -> AppResult<TopologyInsight> {
        let Some(management) = &self.management else {
            return Err(AppError::Unsupported(
                "路由估算需要 RabbitMQ 管理 API（15672 端口），请在连接配置里填写管理地址"
                    .to_owned(),
            ));
        };

        let exchanges = management.exchanges(&self.config).await?;
        let bindings = management.bindings(&self.config).await?;
        let queues = management
            .queue_metrics(&self.config)
            .await
            .unwrap_or_default();

        Ok(analyze_topology(&exchanges, &bindings, &queues))
    }

    /// 发送预览：这条消息会被投到哪些队列。
    ///
    /// 与 `topology_insight` 共用同一份拓扑快照，但回答的是另一件事 ——
    /// 那边是「这个交换机大致通向哪」，这边是「我这一条，带这个 key，会落到谁手里」。
    /// 发送页需要的正是后者：routing key 打错一个字母时，两者会给出完全不同的结论。
    pub async fn predict_send(
        &self,
        exchange: &str,
        routing_key: &str,
        headers: &[MessageHeader],
    ) -> AppResult<SendRoute> {
        let Some(management) = &self.management else {
            return Err(AppError::Unsupported(
                "发送预览需要 RabbitMQ 管理 API（15672 端口），请在连接配置里填写管理地址"
                    .to_owned(),
            ));
        };

        let exchanges = management.exchanges(&self.config).await?;
        let bindings = management.bindings(&self.config).await?;
        // 队列只用来判断默认交换机的「同名直投」；拉不到也不该把预览整页打掉。
        let queues = management.queues(&self.config).await.unwrap_or_default();
        let names: Vec<String> = queues.into_iter().map(|queue| queue.name).collect();

        Ok(predict_send_route(
            &exchanges,
            &bindings,
            &names,
            exchange,
            routing_key,
            headers,
        ))
    }

    /// 拉取队列中的消息。
    ///
    /// 用 `basic.reject(requeue=true)` 把消息放回队列：面板只是「看一眼」，
    /// 不能因为查看动作让消息从队列里消失。代价是同一条消息会被反复读到，
    /// 所以这里只取一次，由上层按需去重。
    pub async fn get_messages(&self, queue: &str, limit: usize) -> AppResult<Vec<RawDelivery>> {
        Ok(self.poll(queue, limit, PollMode::View).await?.1)
    }

    /// 取「某一条」消息，供重投 / 移入死信使用。
    ///
    /// 返回取消息用的通道：AMQP 的 deliveryTag 只在所属通道内有效，
    /// 收尾（ack / reject）必须在同一个通道上做，换个通道会直接报错。
    ///
    /// 走 `Hold`（`no_ack = false` + 读后不自动放回）：
    /// 消息要先挂在通道上，`take_one` 才能把没用上的那些 reject 回队列。
    /// 若开 `no_ack = true`，服务端取走即删，那一步 requeue 只会报错，
    /// 「找一条」就等于把队头 MAX_TAKE 条一起吞了。
    pub async fn take_messages(
        &self,
        queue: &str,
        limit: usize,
    ) -> AppResult<(lapin::Channel, Vec<RawDelivery>)> {
        self.poll(queue, limit, PollMode::Hold).await
    }

    /// 在同一条通道上连续取消息。
    ///
    /// 批量处置必须复用一条消费通道：
    /// - AMQP 的 deliveryTag 只在所属通道内有效，收尾只能在同一通道做；
    /// - 每开一条通道都要重新握手，几十条消息就是几十次往返。
    ///
    /// 调用方负责把不要的消息放回队列——否则「找几条」会把队头整段吞掉。
    pub async fn take_consumer(&self, queue: &str) -> AppResult<TakeConsumer> {
        Ok(TakeConsumer {
            channel: self.channel().await?,
            queue: queue.to_owned(),
        })
    }

    /// 轮询队列拿到一批消息，按 `mode` 决定读完之后怎么处理它们。
    ///
    /// 两种模式的差别只有一件事：消息读出来之后还不还回队列。
    /// 查看（`View`）读完立刻还，否则看一眼就等于删一条；
    /// 挑一条（`Hold`）不还 —— 得留在手上，等调用方用完再统一放回
    /// （见 `take_messages`），否则重投 / 进死信之后原队列里还留着一份，
    /// 用户会看到「操作成功了，但队列没变」。
    ///
    /// 两种模式都走 `no_ack = false`：消息先挂在通道上，收尾只有 ack / reject 两条路。
    /// 返回消费通道：调用方必须在**同一个通道**上收尾 —— AMQP 的 deliveryTag
    /// 只在所属通道内有效，换一个通道收尾会直接报错。
    async fn poll(
        &self,
        queue: &str,
        limit: usize,
        mode: PollMode,
    ) -> AppResult<(lapin::Channel, Vec<RawDelivery>)> {
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

            if mode == PollMode::View {
                // 纯查看：读后立即放回队列，保证查看行为无副作用。
                channel
                    .basic_reject(delivery.delivery_tag, BasicRejectOptions { requeue: true })
                    .await
                    .map_err(AppError::from)?;
            }
        }

        Ok((channel, deliveries))
    }

    /// 队列声明的参数（死信策略等），供消息处置前置校验使用。
    pub async fn queue_arguments(&self, queue: &str) -> AppResult<Vec<KeyValue>> {
        Ok(self.queue_detail(queue).await?.arguments)
    }

    /// 发布消息到交换机。
    pub async fn publish(
        &self,
        exchange: &str,
        routing_key: &str,
        payload: &[u8],
        headers: &[(String, String)],
    ) -> AppResult<String> {
        let properties = BasicProperties::default()
            .with_content_type("text/plain".into())
            .with_headers(field_table_from_headers(headers));
        self.publish_with(exchange, routing_key, payload, properties)
            .await
    }

    /// 按给定的 properties 发布消息。
    ///
    /// 重投 / 移入死信必须走这条路：手工发一条消息用默认 properties 是对的，
    /// 但「把原来的消息再送一次」若只带 headers，`message_id`、`correlation_id`、
    /// `content_type` 全会丢掉——下游按 message_id 去重的服务会把它当成新消息。
    pub async fn publish_with(
        &self,
        exchange: &str,
        routing_key: &str,
        payload: &[u8],
        properties: BasicProperties,
    ) -> AppResult<String> {
        let channel = self.channel().await?;

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

    /// 把消息投递到队列（管理 API 的 `publish` 接口）。
    ///
    /// 与 `publish_with` 的区别在「谁负责路由」：这里直接把消息交给某个队列，
    /// 不经过交换机，因此不需要目标交换机的权限——`configure` 权限比
    /// 交换机 `write` 权限容易拿到得多（批量处置靠这条路径）。
    pub async fn publish_to_queue(
        &self,
        queue: &str,
        payload: &[u8],
        properties: &serde_json::Value,
    ) -> AppResult<()> {
        self.management()?
            .publish_to_queue(&self.config, queue, payload, properties)
            .await
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

    /// 队列到消费者的连线：谁在消费、预取多少、有没有卡死。
    pub async fn consumer_links(&self) -> AppResult<ConsumerLinks> {
        self.management()?.consumer_links(&self.config).await
    }

    /// 断开一个消费者。
    ///
    /// 服务端会关掉该 consumer 所在的 channel，对端随即失去这个消费入口。
    /// 因此必须先按 `DisconnectRequest::validate` 核对用户确认的队列名，
    /// 再按 `domain::consumer_disconnect` 的判定复核 tag —— 这两步都在命令层做，
    /// 这里只做「最后一个不能省的自检」：tag 不能为空。
    pub async fn disconnect_consumer(&self, consumer_tag: &str) -> AppResult<()> {
        let tag = consumer_tag.trim();
        if tag.is_empty() {
            return Err(AppError::Invalid("消费者标签不能为空".to_owned()));
        }
        self.management()?
            .disconnect_consumer(&self.config, tag)
            .await
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

    /// 当前 vhost 下的交换机名字列表，用于校验死信目标是否真的存在。
    pub async fn exchange_names(&self) -> AppResult<Vec<String>> {
        Ok(self
            .management()?
            .exchanges(&self.config)
            .await?
            .into_iter()
            .map(|exchange| exchange.name)
            .collect())
    }

    /// 策略快照：普通策略 + 操作员策略。
    ///
    /// 和队列列表不同，这里**没有**管理 API 就不返回空快照，而是直接报错：
    /// 「策略页显示 0 条」会被读成「这个 vhost 没有策略」，是错误结论；
    /// 空列表和查不到必须区分开。
    pub async fn policies(&self) -> AppResult<PolicySnapshot> {
        self.management()?.policies(&self.config).await
    }

    /// 新建 / 修改策略。
    pub async fn put_policy(&self, spec: &PolicySpec, name: &str) -> AppResult<()> {
        self.management()?
            .put_policy(&self.config, spec, name)
            .await
    }

    /// 删除策略。
    pub async fn delete_policy(&self, name: &str) -> AppResult<()> {
        self.management()?.delete_policy(&self.config, name).await
    }

    /// 参数快照：按组件逐个拉，某一类失败只影响它自己。
    ///
    /// 和策略同理，这里不做「没管理 API 就返回空快照」的处理：
    /// 空列表会被读成「这个 vhost 没配参数」，而真实情况是根本没查。
    pub async fn parameters(&self) -> AppResult<ParameterSnapshot> {
        self.management()?.parameters(&self.config).await
    }

    /// 新建 / 修改参数（同名即替换）。
    pub async fn put_parameter(
        &self,
        component: ParameterComponent,
        vhost: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> AppResult<()> {
        self.management()?
            .put_parameter(&self.config, component, vhost, name, value)
            .await
    }

    /// 删除参数。
    pub async fn delete_parameter(
        &self,
        component: ParameterComponent,
        vhost: &str,
        name: &str,
    ) -> AppResult<()> {
        self.management()?
            .delete_parameter(&self.config, component, vhost, name)
            .await
    }

    /// 取管理 API 客户端，未配置时给出统一的引导文案。
    pub(super) fn management(&self) -> AppResult<&ManagementClient> {
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

/// 处置用的消费通道：在同一条通道上逐条取消息。
///
/// 单独成类型，是为了让「取消息的通道」和「收尾的通道」天然是同一个，
/// 谁都拿不到另一条通道来 ack。
pub struct TakeConsumer {
    channel: lapin::Channel,
    queue: String,
}

impl TakeConsumer {
    /// 取出下一条消息；队列已空时返回 `None`。
    ///
    /// 必须走 `no_ack = false`：消息在收尾之前要一直挂在通道上，
    /// 这样「取出来却没能处置」的消息还有 `requeue` 这条路可走。
    /// 开 `no_ack = true` 时服务端已经把消息删掉了，事后再 `basic.reject`
    /// 会直接吃一个 `unknown delivery tag` 通道级错误——消息既没处置也没回队列，
    /// 就这么没了。收尾动作必须在同一个通道上做，理由见 `RawDelivery` 的注释。
    pub async fn next(&mut self) -> AppResult<Option<RawDelivery>> {
        let delivery = self
            .channel
            .basic_get(
                ShortString::from(self.queue.clone()),
                BasicGetOptions { no_ack: false },
            )
            .await
            .map_err(AppError::from)?;

        Ok(delivery.map(|delivery| RawDelivery {
            queue: self.queue.clone(),
            exchange: delivery.exchange.to_string(),
            routing_key: delivery.routing_key.to_string(),
            delivery_tag: delivery.delivery_tag,
            redelivered: delivery.redelivered,
            properties: delivery.properties.clone(),
            payload: delivery.data.clone(),
        }))
    }

    /// 把取出来的消息放回去，让它继续留在原队列里。
    ///
    /// 与 `drop_message` 相对：处置失败或没轮到时用这条，保证「消息还在」。
    ///
    /// 只读、不改数据的路径请用 `View` 模式（读后立刻放回），不要走这里：
    /// 一条纯查看用的消息被取出来再放回，`redelivered` 就被置位了，
    /// 下游的幂等逻辑会多算一次重复投递。
    pub async fn requeue(&self, delivery_tag: u64) -> AppResult<()> {
        self.channel
            .basic_reject(delivery_tag, BasicRejectOptions { requeue: true })
            .await
            .map_err(AppError::from)
    }

    /// 让消息从队列里永久消失（已确认发布落地之后才能调）。
    pub async fn drop_message(&self, delivery_tag: u64) -> AppResult<()> {
        self.channel
            .basic_reject(delivery_tag, BasicRejectOptions { requeue: false })
            .await
            .map_err(AppError::from)
    }
}

/// 轮询模式：读出来的消息还不还回队列。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PollMode {
    /// 纯查看：读完立刻 `basic.reject(requeue = true)` 放回原队列。
    View,
    /// 挑一条：消息留在调用方手上，由它决定 ack / reject。
    ///
    /// 与 `View` 相反，这里**不**当场放回：调用方要拿到一条仍然有效的消息
    /// 去做重投 / 进死信。途中顺带取出来的那些由调用方负责放回。
    Hold,
}

/// 毫秒时间戳。健康报告要展示「几秒前探测的」，因此统一用毫秒。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}
