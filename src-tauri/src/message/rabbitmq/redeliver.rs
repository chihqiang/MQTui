//! RabbitMQ 消息处置：重新投递、移入死信。
//!
//! 两个动作共用同一条流水线——**先发布、再丢弃原消息**：
//!
//! 1. 在消费通道上拿到那条消息（`no_ack`，拿到后由我们负责收尾）；
//! 2. 发布一份到目标交换机，等 publisher confirm；
//! 3. 确认落地之后，才让原消息从队列里消失。
//!
//! 顺序不能反：先丢弃再发布，一旦发布失败，消息就凭空蒸发了。
//! 中途失败时原消息仍未确认，报错退出，让服务端按未确认消息处理——明确失败好过静默丢失。
//!
//! 第 3 步必须在**取消息的那个通道**上做：AMQP 的 deliveryTag 只在所属通道内有效，
//! 换个通道 ack 会直接报 `unknown delivery tag`，消息留在 unacked 直到连接断开才回队列。

use lapin::BasicProperties;
use lapin::options::BasicRejectOptions;
use lapin::types::{AMQPValue, FieldTable};

use std::collections::HashMap;

use crate::broker::rabbitmq::RabbitMqClient;
use crate::broker::rabbitmq::client::{RawDelivery, TakeConsumer};
use crate::domain::redeliver::{
    resolve_dead_letter_target, resolve_redeliver_target, stranded_retry_ids,
};
use crate::domain::{
    BatchDisposalItem, BatchDisposalOutcome, BatchDisposalRequest, BatchItemStatus,
    DISPOSAL_REDELIVER, DeadLetterPolicy, DeadLetterRequest, DeliveryInfo, DisposalCapabilities,
    DisposalOutcome, KeyValue, RedeliverRequest, normalize_batch,
};
use crate::error::{AppError, AppResult};

use super::dto;

/// 原始交换机 header 名，RabbitMQ 转发 / 死信时写入。
const ORIGINAL_EXCHANGE_HEADER: &str = "x-original-exchange";
/// 原始 routing key header 名。
const ORIGINAL_ROUTING_KEY_HEADER: &str = "x-original-routing-key";
/// 死信计数头。处置时要剥掉，否则新队列会以为这条消息「死过」。
const DEATH_HEADER: &str = "x-death";
/// 逐个取消息找标签时最多取多少条。取多了会把队头整段压进内存。
const MAX_TAKE: usize = crate::message::MAX_MESSAGE_LIMIT;

/// 死信路由头。已剥掉 `x-death` 之后单独留着它没有意义，一并去掉。
const DEATH_ROUTING_HEADER: &str = "x-death-routing-key";

/// 读取一条消息的处置能力：能不能重投、能不能进死信，以及不能的原因。
pub async fn capabilities(
    client: &RabbitMqClient,
    message_id: &str,
) -> AppResult<DisposalCapabilities> {
    let (queue, _) = dto::parse_id(message_id)?;
    let policy = policy_of(client, &queue).await?;

    // 死信交换机是否真的存在只能问管理 API。查不到时不拦（得到的是空列表），
    // 拦错了会让「明明配了死信」的用户用不了这个按钮，代价比放过一次大。
    let known = client.exchange_names().await.unwrap_or_default();
    let (can_dead_letter, block) = DisposalCapabilities::evaluate(&policy, &known);

    let mut reasons = Vec::new();
    if !can_dead_letter {
        reasons.push(KeyValue::new("deadLetter", block.reason()));
    }

    Ok(DisposalCapabilities {
        // 重投目标由用户填，消息本身不影响可操作性。
        can_redeliver: true,
        can_dead_letter,
        reasons,
    })
}

/// 重新投递一条消息。
pub async fn redeliver(
    client: &RabbitMqClient,
    request: &RedeliverRequest,
) -> AppResult<DisposalOutcome> {
    let (queue, tag) = dto::parse_id(&request.message_id)?;
    let taken = take_one(client, &queue, tag).await?;

    let (exchange, routing_key) =
        resolve_redeliver_target(&delivery_info(&taken.delivery), request);
    let detail = publish_copy(client, &taken, &exchange, &routing_key).await?;
    taken.drop_message().await?;

    Ok(DisposalOutcome {
        action: "redeliver".to_owned(),
        exchange,
        routing_key,
        detail,
    })
}

/// 把一条消息移入队列声明的死信交换机。
pub async fn dead_letter(
    client: &RabbitMqClient,
    request: &DeadLetterRequest,
) -> AppResult<DisposalOutcome> {
    let (queue, tag) = dto::parse_id(&request.message_id)?;
    let policy = policy_of(client, &queue).await?;

    // 先判后做：投进一个不存在的交换机，消息会被服务端静默丢弃，
    // 而原消息同时被我们丢弃——两边都没了。
    let known = client.exchange_names().await?;
    match DisposalCapabilities::evaluate(&policy, &known) {
        (true, _) => {}
        (false, block) => return Err(AppError::Unsupported(block.reason())),
    }

    let taken = take_one(client, &queue, tag).await?;
    let (exchange, routing_key) =
        resolve_dead_letter_target(&delivery_info(&taken.delivery), &policy);
    let detail = publish_copy(client, &taken, &exchange, &routing_key).await?;
    taken.drop_message().await?;

    Ok(DisposalOutcome {
        action: "deadLetter".to_owned(),
        exchange,
        routing_key,
        detail,
    })
}

/// 批量处置：对同一个队列里的若干条消息执行同一个动作。
///
/// 四条规则，都是为了让「哪几条成了」有确切答案：
///
/// 1. **逐条串行**：每条都要等投递结果，再决定原消息的去留。
/// 2. **一条失败就停下**：后面的消息标记为 `skipped` 并原样放回队列。
///    继续跑只会让集群里出现更难收拾的半截状态。
/// 3. **每条都要有结果**：包括「没找到这条消息」——它同样是一条明确的事实。
/// 4. **整批同一个队列**：死信目标来自队列声明，混着多个队列的批量
///    会让「为什么要投到这里」没法一句话说清。
pub async fn batch(
    client: &RabbitMqClient,
    request: &BatchDisposalRequest,
) -> Result<BatchDisposalOutcome, String> {
    let ids = normalize_batch(request)?;
    let queue = single_queue(&ids)?;
    let action = request.action.as_str();
    let plan = Plan::build(client, request, &queue).await?;

    let outcome = run_round(client, &queue, &plan, action, &ids, true).await?;
    Ok(outcome)
}

/// 重试一批「没放回队列」的消息。
///
/// 不需要用户重新选一遍、也不需要他记得当时选了哪几条：结果里带回来的
/// 就是那批卡的 ID（`BatchDisposalOutcome::stranded`），原样递回来即可。
///
/// 重试**不处置**这些消息，只把它们放回队列 —— 它们本来就是用户没选中的那些，
/// 上一次只是「顺带取出来了却没还回去」。所以这里一个都不该被发布、被丢弃。
pub async fn retry_stranded(
    client: &RabbitMqClient,
    request: &BatchDisposalRequest,
) -> Result<BatchDisposalOutcome, String> {
    let ids = stranded_retry_ids(&request.queue, &request.message_ids)?;
    let plan = Plan::build(client, request, &request.queue).await?;

    run_round(client, &request.queue, &plan, &request.action, &ids, false).await
}

/// 一轮处置：取消息、按计划处置、把顺带取出的放回。
///
/// `dispose` 为 `false` 时只做最后一步——那是「重试放回」的路径，
/// 目标消息本身一条都不该被动到。
async fn run_round(
    client: &RabbitMqClient,
    queue: &str,
    plan: &Plan,
    action: &str,
    ids: &[String],
    dispose: bool,
) -> Result<BatchDisposalOutcome, String> {
    let mut consumer = client
        .take_consumer(queue)
        .await
        .map_err(|e| e.to_string())?;
    // 已经取出来、但还不是当前目标的消息：投递标签 → 投递信息。
    //
    // 重试路径下「目标」本身就是别人上一次取出来的消息，所以它们照样先落进
    // `held`：找到的那条从 `held` 里摘出来当目标（把它放回去），
    // 没找到的那些也不是我们要的，一起放回。两条路最后汇总成同一张 `held` 表。
    let mut held: HashMap<u64, RawDelivery> = HashMap::new();
    let mut items = Vec::with_capacity(ids.len());
    let mut stopped = false;

    for id in ids {
        let (_, tag) = dto::parse_id(id).map_err(|error| error.to_string())?;

        if stopped {
            items.push(BatchDisposalItem {
                message_id: id.clone(),
                status: BatchItemStatus::Skipped,
                detail: "这一批已因前面的失败停止，本条未执行，消息仍在队列里".to_owned(),
            });
            continue;
        }

        let delivery = match take_target(&mut consumer, tag, &mut held).await {
            Ok(delivery) => delivery,
            Err(reason) => {
                items.push(failed(id, &reason));
                stopped = true;
                continue;
            }
        };

        if !dispose {
            // 重试：目标消息要回到队列，交给最后的 `return_held` 统一做。
            held.insert(delivery.delivery_tag, delivery);
            items.push(BatchDisposalItem {
                message_id: id.clone(),
                status: BatchItemStatus::Ok,
                detail: format!("已从队列 {queue} 取到，稍后放回"),
            });
            continue;
        }

        match dispose_one(client, &consumer, plan, action, queue.to_owned(), delivery).await {
            Ok(detail) => items.push(BatchDisposalItem {
                message_id: id.clone(),
                status: BatchItemStatus::Ok,
                detail,
            }),
            Err(reason) => {
                items.push(failed(id, &reason));
                stopped = true;
            }
        }
    }

    // 取出来但没轮到的消息一律放回：批量选几条不能等于删几条。
    //
    // 这一步以前是 `let _ = requeue(...)` 一把吞掉错误。放回失败的消息此时既不在
    // 队列里、也没有任何记录，等于静默丢失 —— 而它是本次根本没打算处置的那批。
    // 现在把失败的那些 ID 写进结果（`stranded`），界面据此提供一个「重试这批」。
    let stranded = return_held(&consumer, held).await;
    let mut outcome = BatchDisposalOutcome::from_items(action, items);
    outcome.retryable = Some(!stranded.is_empty());
    outcome.stranded = stranded;

    Ok(outcome)
}

/// 把顺带取出来的消息全部放回队列，返回放回失败的那些 ID。
///
/// 失败的不能只 `let _ =`：那条消息此时既不在队列里、也没有任何记录。
/// 只报一个计数也没用 —— 界面除了说一句「有 3 条卡住了」什么都做不了，
/// 用户只能干等连接关闭。带上 ID，重试那条路才有东西可指。
async fn return_held(consumer: &TakeConsumer, held: HashMap<u64, RawDelivery>) -> Vec<String> {
    let mut failed = Vec::new();
    // 按投递标签排序：同一批失败的人看到的是稳定的顺序，重试的也是同一条顺序。
    let mut deliveries: Vec<RawDelivery> = held.into_values().collect();
    deliveries.sort_by_key(|delivery| delivery.delivery_tag);
    for delivery in deliveries {
        if consumer.requeue(delivery.delivery_tag).await.is_err() {
            failed.push(dto::message_id(&delivery));
        }
    }
    failed
}

/// 整批必须属于同一个队列，返回该队列名。
fn single_queue(ids: &[String]) -> Result<String, String> {
    let mut queues = ids.iter().map(|id| {
        dto::parse_id(id)
            .map(|(queue, _)| queue)
            .map_err(|error| error.to_string())
    });
    let Some(first) = queues.next() else {
        return Err("请至少选择一条消息".to_owned());
    };
    let queue = first?;
    for other in queues {
        if other? != queue {
            return Err("批量处置只支持同一个队列里的消息，请按队列分批操作".to_owned());
        }
    }
    Ok(queue)
}

/// 一批处置的目标。目标在循环外算一次，不为每条消息重复查拓扑。
struct Plan {
    exchange: String,
    /// routing key；空串表示「沿用每条消息各自的原始 routing key」。
    routing_key: String,
}

impl Plan {
    /// 目标在动手之前全部确定，任何一条不成立就整批拒绝。
    ///
    /// 「先做一半再发现目标不存在」是这类操作最糟的失败方式：
    /// 已经移走的消息不会因为后面的失败而回来。
    async fn build(
        client: &RabbitMqClient,
        request: &BatchDisposalRequest,
        queue: &str,
    ) -> Result<Self, String> {
        if request.action == DISPOSAL_REDELIVER {
            return Ok(Self {
                exchange: request.exchange.trim().to_owned(),
                routing_key: request.routing_key.trim().to_owned(),
            });
        }

        let policy = policy_of(client, queue).await.map_err(|e| e.to_string())?;
        // 查不到交换机列表时不拦（得到空列表），理由与单条处置一致。
        let known = client.exchange_names().await.unwrap_or_default();
        match DisposalCapabilities::evaluate(&policy, &known) {
            (true, _) => Ok(Self {
                exchange: policy.exchange.clone().unwrap_or_default(),
                routing_key: policy.routing_key.clone().unwrap_or_default(),
            }),
            (false, block) => Err(block.reason()),
        }
    }

    /// 这条消息该投到哪。
    ///
    /// routing key 留空时，重投沿用消息的**原始** routing key（`x-original-routing-key`），
    /// 死信则沿用当前 routing key——这是 RabbitMQ 自己的死信语义。
    fn target_of(&self, delivery: &RawDelivery, action: &str) -> (String, String) {
        let info = delivery_info(delivery);
        if action == DISPOSAL_REDELIVER {
            return resolve_redeliver_target(
                &info,
                &RedeliverRequest {
                    connection_id: String::new(),
                    message_id: String::new(),
                    exchange: self.exchange.clone(),
                    routing_key: self.routing_key.clone(),
                },
            );
        }
        resolve_dead_letter_target(
            &info,
            &DeadLetterPolicy {
                exchange: Some(self.exchange.clone()),
                routing_key: (!self.routing_key.is_empty()).then(|| self.routing_key.clone()),
            },
        )
    }
}

/// 顺序取消息，直到拿到指定的投递标签。
///
/// 投递标签在「查看」之后会被服务端重新分配，所以没法直接跳到某一条：
/// 只能边取边认领，途中取出的消息先留着（它们仍被本次消费持有），
/// 等整批结束后统一放回队列。
async fn take_target(
    consumer: &mut TakeConsumer,
    tag: u64,
    held: &mut HashMap<u64, RawDelivery>,
) -> Result<RawDelivery, String> {
    if let Some(delivery) = held.remove(&tag) {
        return Ok(delivery);
    }

    for _ in 0..MAX_TAKE {
        match consumer.next().await.map_err(|error| error.to_string())? {
            Some(delivery) if delivery.delivery_tag == tag => return Ok(delivery),
            // 先记着，仍持有这条消息，等循环结束统一放回队列。
            Some(delivery) => {
                held.insert(delivery.delivery_tag, delivery);
            }
            None => break,
        }
    }

    Err(format!(
        "队列中已找不到投递标签 {tag} 的消息（可能已被消费或过期）"
    ))
}

/// 对一条已经取到手的消息执行处置：**结果确定之后**才让原消息从队列消失。
///
/// 两条投递路径，按可用性降级：
///
/// 1. AMQP：发布到目标交换机，等 publisher confirm。
/// 2. 管理 API：被交换机拒（没开 `confirm_select`、或没有该交换机的 `write` 权限）时，
///    改由管理 API 直接投递到队列。它绕开交换机，因此不需要交换机写权限；
///    代价是 message_id 会变成新的（服务端以为这是新消息），所以结果里要说清。
///
/// 两条都不成，原消息原样留在队列里，并如实说明。
async fn dispose_one(
    client: &RabbitMqClient,
    consumer: &TakeConsumer,
    plan: &Plan,
    action: &str,
    queue: String,
    delivery: RawDelivery,
) -> Result<String, String> {
    let (exchange, routing_key) = plan.target_of(&delivery, action);
    let properties = publishable_properties(&delivery.properties);

    match client
        .publish_with(
            &exchange,
            &routing_key,
            &delivery.payload,
            properties.clone(),
        )
        .await
    {
        Ok(_) => {
            consumer
                .drop_message(delivery.delivery_tag)
                .await
                .map_err(|error| {
                    format!("已发布到 {exchange}/{routing_key}，但原消息未能从队列移除：{error}")
                })?;
            Ok(format!(
                "已送到 {exchange} / {routing_key}，原消息已从队列移除"
            ))
        }
        Err(error) => {
            let amqp_error = error.to_string();

            match client
                .publish_to_queue(&queue, &delivery.payload, &properties_to_json(&properties))
                .await
            {
                Ok(()) => {
                    consumer
                        .drop_message(delivery.delivery_tag)
                        .await
                        .map_err(|error| {
                            format!(
                                "已通过管理 API 投回队列 {queue}，但原消息未能从队列移除：{error}"
                            )
                        })?;
                    Ok(format!(
                        "交换机投递失败（{amqp_error}），已改由管理 API 投回队列 {queue}：\
                         消息仍在同一队列里，但服务端会把它当成新消息（message_id 会变）"
                    ))
                }
                Err(fallback_error) => Err(format!(
                    "投递失败，原消息仍在队列里：AMQP {amqp_error}；管理 API {fallback_error}"
                )),
            }
        }
    }
}

/// 把一条消息的 properties 转成管理 API 的 `properties` 字段。
///
/// 以前这里只搬了 headers，其余属性一概没带：于是「AMQP 发不出去、退回管理 API」
/// 这条兜底路径上，`expiration`（TTL）、`priority`、`delivery_mode`（持久化）
/// 会静默消失——投递「成功」，消息却变成另一条：本该几秒后过期的活了下来，
/// 本该进高优先级的排到了队尾，本来重启后还在的丢了。
///
/// 字段名与类型按 RabbitMQ 管理 API 的 `to_basic_properties/1` 来：
/// `delivery_mode` / `priority` / `timestamp` 必须是**数字**（传字符串会被拒），
/// 其余必须是字符串，`type` 是 AMQP 里 `kind` 的对外名字。
///
/// `cluster_id` 是给集群内部用的路由标记，不属于「这条消息是谁、要不要过期、
/// 该排多前」的语义，不带过去（带上反而可能让服务端按旧集群规则处置）。
fn properties_to_json(properties: &BasicProperties) -> serde_json::Value {
    let mut table = serde_json::Map::new();

    let text = [
        ("content_type", properties.content_type().as_ref()),
        ("content_encoding", properties.content_encoding().as_ref()),
        ("correlation_id", properties.correlation_id().as_ref()),
        ("reply_to", properties.reply_to().as_ref()),
        ("expiration", properties.expiration().as_ref()),
        ("message_id", properties.message_id().as_ref()),
        ("type", properties.kind().as_ref()),
        ("user_id", properties.user_id().as_ref()),
        ("app_id", properties.app_id().as_ref()),
    ];
    for (key, value) in text {
        if let Some(value) = value {
            table.insert(
                key.to_owned(),
                serde_json::Value::String(value.as_str().to_owned()),
            );
        }
    }

    if let Some(value) = properties.delivery_mode() {
        table.insert("delivery_mode".to_owned(), serde_json::Value::from(*value));
    }
    if let Some(value) = properties.priority() {
        table.insert("priority".to_owned(), serde_json::Value::from(*value));
    }
    if let Some(value) = properties.timestamp() {
        table.insert("timestamp".to_owned(), serde_json::Value::from(*value));
    }
    if let Some(headers) = properties.headers() {
        let mut nested = serde_json::Map::new();
        for (key, value) in headers.inner() {
            nested.insert(key.to_string(), header_to_json(value));
        }
        table.insert("headers".to_owned(), serde_json::Value::Object(nested));
    }

    serde_json::Value::Object(table)
}

/// 把 AMQP header 值转成管理 API 能接受的 JSON。
///
/// 只处理能无损表达的三种（字符串 / 整数 / 布尔），其余降级成字符串——
/// 批量重投时丢一个非典型 header，比整条消息投不出去好。
fn header_to_json(value: &AMQPValue) -> serde_json::Value {
    match value {
        AMQPValue::LongString(value) => {
            serde_json::Value::String(String::from_utf8_lossy(value.as_bytes()).into_owned())
        }
        AMQPValue::ShortString(value) => serde_json::Value::String(
            String::from_utf8_lossy(value.as_str().as_bytes()).into_owned(),
        ),
        AMQPValue::Boolean(value) => serde_json::Value::Bool(*value),
        AMQPValue::LongLongInt(value) => serde_json::Value::from(*value),
        AMQPValue::LongInt(value) => serde_json::Value::from(*value),
        other => serde_json::Value::String(format!("{other:?}")),
    }
}

fn failed(id: &str, reason: &str) -> BatchDisposalItem {
    BatchDisposalItem {
        message_id: id.to_owned(),
        status: BatchItemStatus::Failed,
        detail: reason.to_owned(),
    }
}

/// 读队列参数并解析死信策略。
async fn policy_of(client: &RabbitMqClient, queue: &str) -> AppResult<DeadLetterPolicy> {
    let arguments = client.queue_arguments(queue).await?;
    Ok(DeadLetterPolicy::from_arguments(&arguments))
}

/// 被取出来的一条消息，连同它能收尾的那条消费通道。
///
/// 单独成类型是为了让「必须用同一个通道收尾」这件事写在类型上，
/// 而不是靠调用方记得。
pub(super) struct Taken {
    channel: lapin::Channel,
    delivery: RawDelivery,
}

impl Taken {
    /// 消息已被妥善处置（发布确认落地），让它从原队列消失。
    pub(super) async fn drop_message(self) -> AppResult<()> {
        self.channel
            .basic_reject(
                self.delivery.delivery_tag,
                BasicRejectOptions { requeue: false },
            )
            .await
            .map_err(AppError::from)
    }

    /// 消息用不上，放回队列。
    #[allow(dead_code)]
    pub(super) async fn requeue(self) -> AppResult<()> {
        self.channel
            .basic_reject(
                self.delivery.delivery_tag,
                BasicRejectOptions { requeue: true },
            )
            .await
            .map_err(AppError::from)
    }
}

/// 一路取到目标投递标签为止，顺带把同批多取出来的消息放回队列。
///
/// 列表里的投递标签属于「上一次查看」的会话，这次重新取到的标签可能整体后移；
/// 但用户点操作时队列里的顺序通常没变，所以取到即用，取不到就明确说消息不在了。
async fn take_one(client: &RabbitMqClient, queue: &str, tag: u64) -> AppResult<Taken> {
    let (channel, mut deliveries) = client.take_messages(queue, MAX_TAKE).await?;
    let position = deliveries
        .iter()
        .position(|delivery| delivery.delivery_tag == tag);

    let Some(position) = position else {
        // 没找到也要把已经取出的消息还回去，否则「找一条」会把队头整段吞掉。
        for delivery in &deliveries {
            channel
                .basic_reject(delivery.delivery_tag, BasicRejectOptions { requeue: true })
                .await
                .map_err(AppError::from)?;
        }
        return Err(AppError::NotFound(format!(
            "队列 {queue} 中已找不到投递标签 {tag} 的消息（可能已被消费或过期）"
        )));
    };

    let target = deliveries.swap_remove(position);
    for other in &deliveries {
        channel
            .basic_reject(other.delivery_tag, BasicRejectOptions { requeue: true })
            .await
            .map_err(AppError::from)?;
    }

    Ok(Taken {
        channel,
        delivery: target,
    })
}

/// 复制一份发布到目标交换机。
///
/// 整份 properties 原样带过去（只剥掉服务端维护的死信头）：
/// 重投出去的消息应该和原来那条长得一样——`message_id`、`correlation_id`、
/// `content_type`、`expiration` 缺任何一个，下游收到就是另一条消息。
async fn publish_copy(
    client: &RabbitMqClient,
    taken: &Taken,
    exchange: &str,
    routing_key: &str,
) -> AppResult<String> {
    let delivery = &taken.delivery;
    client
        .publish_with(
            exchange,
            routing_key,
            &delivery.payload,
            publishable_properties(&delivery.properties),
        )
        .await
}

/// 去掉服务端维护的死信相关头，其余原样保留。
///
/// 只删 `x-death` 会留下 `x-first-death-*` / `x-death-routing-key` 这类兄弟字段，
/// 新队列看到它们照样以为这条消息「死过」。
fn publishable_properties(properties: &BasicProperties) -> BasicProperties {
    let Some(updated) = strip_death_headers(properties.headers().as_ref()) else {
        return properties.clone();
    };
    properties.clone().with_headers(updated)
}

/// 剥掉死信头，返回新的 header 表；本来就没有死信头时返回 `None`。
fn strip_death_headers(headers: Option<&FieldTable>) -> Option<FieldTable> {
    let headers = headers?;
    let mut alive = FieldTable::default();
    let mut dropped = 0;

    for (key, value) in headers.inner() {
        if is_death_header(key.as_str()) {
            dropped += 1;
            continue;
        }
        alive.insert(key.clone(), value.clone());
    }

    (dropped > 0).then_some(alive)
}

/// 是否属于服务端维护的死信头（`x-death`、`x-first-death-reason` 等）。
fn is_death_header(key: &str) -> bool {
    key == DEATH_HEADER || key == DEATH_ROUTING_HEADER || key.starts_with("x-first-death-")
}

/// 从原始投递里提炼处置需要的信息。
///
/// 只认字符串类型的头：`x-original-routing-key` 这类由 RabbitMQ 写入的值本来就是
/// 长字符串，遇到其它类型说明不是我们要的东西，宁可当它不存在。
fn delivery_info(delivery: &RawDelivery) -> DeliveryInfo {
    let headers = delivery.properties.headers();
    let header = |key: &str| {
        headers
            .as_ref()
            .and_then(|headers| headers.inner().get(key))
            .and_then(|value| match value {
                AMQPValue::LongString(value) => {
                    Some(String::from_utf8_lossy(value.as_bytes()).into_owned())
                }
                AMQPValue::ShortString(value) => {
                    Some(String::from_utf8_lossy(value.as_str().as_bytes()).into_owned())
                }
                _ => None,
            })
    };

    DeliveryInfo {
        queue: delivery.queue.clone(),
        exchange: delivery.exchange.clone(),
        routing_key: delivery.routing_key.clone(),
        redelivered: delivery.redelivered,
        original_exchange: header(ORIGINAL_EXCHANGE_HEADER),
        original_routing_key: header(ORIGINAL_ROUTING_KEY_HEADER),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::DISPOSAL_DEAD_LETTER;
    use lapin::types::{FieldTable, LongString, ShortString};

    fn properties(headers: &[(&str, &str)]) -> BasicProperties {
        let mut table = FieldTable::default();
        for (key, value) in headers {
            table.insert(
                ShortString::from(key.to_string()),
                AMQPValue::LongString(LongString::from(value.to_string())),
            );
        }
        BasicProperties::default().with_headers(table)
    }

    fn delivery(properties: BasicProperties) -> RawDelivery {
        RawDelivery {
            queue: "orders".to_owned(),
            exchange: "retry".to_owned(),
            routing_key: "orders.retry".to_owned(),
            delivery_tag: 7,
            redelivered: true,
            properties,
            payload: b"hi".to_vec(),
        }
    }

    /// 只给 `delivery_info` 用的壳子：它是纯函数，拿不到真实通道也该跑得通。
    fn info_of(delivery: RawDelivery) -> DeliveryInfo {
        delivery_info(&delivery)
    }

    #[test]
    fn publishable_properties_drops_all_death_headers() {
        // 只删 x-death 会留下兄弟字段，新队列看到它们照样以为这条消息死过。
        let stripped = publishable_properties(&properties(&[
            ("x-death", "count=3"),
            ("x-first-death-reason", "rejected"),
            ("x-first-death-queue", "orders"),
            ("x-death-routing-key", "orders.retry"),
            ("trace-id", "abc"),
        ]));

        let headers = stripped.headers().as_ref().expect("应当保留 header 表");
        let keys: Vec<&str> = headers.inner().keys().map(|key| key.as_str()).collect();
        assert_eq!(keys, vec!["trace-id"]);
    }

    #[test]
    fn publishable_properties_keeps_message_identity() {
        // 重投出去的必须还是「同一条消息」：message_id / correlation_id / content_type 都在。
        let original = BasicProperties::default()
            .with_message_id("m-1".into())
            .with_correlation_id("c-1".into())
            .with_content_type("application/json".into())
            .with_headers(
                properties(&[("trace-id", "abc")])
                    .headers()
                    .clone()
                    .unwrap_or_default(),
            );

        let published = publishable_properties(&original);
        assert_eq!(
            published.message_id().as_ref().map(|id| id.as_str()),
            Some("m-1")
        );
        assert_eq!(
            published.correlation_id().as_ref().map(|id| id.as_str()),
            Some("c-1")
        );
        assert_eq!(
            published.content_type().as_ref().map(|id| id.as_str()),
            Some("application/json")
        );
        assert_eq!(
            published
                .headers()
                .as_ref()
                .map(|table| table.inner().len()),
            Some(1)
        );
    }

    #[test]
    fn publishable_properties_without_headers_is_unchanged() {
        let original = BasicProperties::default().with_message_id("m-1".into());
        let published = publishable_properties(&original);
        assert!(published.headers().is_none());
        assert_eq!(
            published.message_id().as_ref().map(|id| id.as_str()),
            Some("m-1")
        );
    }

    #[test]
    fn publishable_properties_keeps_original_routing_info() {
        let published = publishable_properties(&properties(&[
            ("x-original-exchange", "orders"),
            ("x-original-routing-key", "order.created"),
        ]));
        let headers = published.headers().clone().unwrap_or_default();
        assert_eq!(headers.inner().len(), 2);
        assert!(headers.inner().contains_key("x-original-routing-key"));
    }

    #[test]
    fn delivery_info_reads_original_routing_key() {
        let info = info_of(delivery(properties(&[
            ("x-original-exchange", "orders"),
            ("x-original-routing-key", "order.created"),
        ])));

        assert_eq!(info.queue, "orders");
        assert_eq!(info.exchange, "retry");
        assert_eq!(info.routing_key, "orders.retry");
        assert!(info.redelivered);
        assert_eq!(info.original_exchange.as_deref(), Some("orders"));
        assert_eq!(info.original_routing_key.as_deref(), Some("order.created"));
    }

    #[test]
    fn delivery_info_without_original_headers_is_none() {
        let info = info_of(delivery(BasicProperties::default()));
        assert!(info.original_exchange.is_none());
        assert!(info.original_routing_key.is_none());
    }

    #[test]
    fn delivery_info_ignores_non_string_headers() {
        // x-original-routing-key 由 RabbitMQ 写成字符串，其它类型说明不是我们要的东西。
        let mut table = FieldTable::default();
        table.insert(
            ShortString::from("x-original-routing-key".to_string()),
            AMQPValue::LongInt(7),
        );
        let info = info_of(delivery(BasicProperties::default().with_headers(table)));
        assert!(info.original_routing_key.is_none());
    }

    #[test]
    fn single_queue_accepts_one_queue() {
        let ids = vec!["orders:1".to_owned(), "orders:2".to_owned()];
        assert_eq!(single_queue(&ids).unwrap(), "orders");
    }

    #[test]
    fn single_queue_rejects_mixed_queues() {
        // 死信目标来自队列声明，混着两个队列就没法说清「为什么投到这里」。
        let ids = vec!["orders:1".to_owned(), "payments:2".to_owned()];
        let error = single_queue(&ids).unwrap_err();
        assert!(error.contains("同一个队列"));
    }

    #[test]
    fn single_queue_keeps_colon_in_name() {
        // `sys:logs:42` 的队列名是 `sys:logs`，不能按第一个冒号切。
        let ids = vec!["sys:logs:42".to_owned(), "sys:logs:43".to_owned()];
        assert_eq!(single_queue(&ids).unwrap(), "sys:logs");
    }

    fn redeliver_plan() -> Plan {
        Plan {
            exchange: String::new(),
            routing_key: String::new(),
        }
    }

    #[test]
    fn batch_redeliver_reuses_each_original_routing_key() {
        // routing key 留空时，每一条都用各自的原始 key，而不是统一成同一个。
        let mut first = delivery(properties(&[("x-original-routing-key", "a.created")]));
        first.delivery_tag = 1;
        let mut second = delivery(properties(&[("x-original-routing-key", "b.created")]));
        second.delivery_tag = 2;

        let plan = redeliver_plan();
        assert_eq!(
            plan.target_of(&first, DISPOSAL_REDELIVER),
            (String::new(), "a.created".to_owned())
        );
        assert_eq!(
            plan.target_of(&second, DISPOSAL_REDELIVER),
            (String::new(), "b.created".to_owned())
        );
    }

    #[test]
    fn batch_redeliver_with_explicit_key_wins_over_original() {
        let plan = Plan {
            exchange: "retry".to_owned(),
            routing_key: "manual".to_owned(),
        };
        let delivery = delivery(properties(&[("x-original-routing-key", "a.created")]));
        assert_eq!(
            plan.target_of(&delivery, DISPOSAL_REDELIVER),
            ("retry".to_owned(), "manual".to_owned())
        );
    }

    #[test]
    fn dead_letter_target_uses_current_routing_key_when_policy_has_none() {
        // 死信语义与重投不同：队列没配 x-dead-letter-routing-key 时沿用**当前** key。
        let plan = Plan {
            exchange: "dlx".to_owned(),
            routing_key: String::new(),
        };
        let delivery = delivery(properties(&[("x-original-routing-key", "obsolete")]));
        assert_eq!(
            plan.target_of(&delivery, DISPOSAL_DEAD_LETTER),
            ("dlx".to_owned(), "orders.retry".to_owned())
        );
    }

    #[test]
    fn dead_letter_target_prefers_policy_routing_key() {
        let plan = Plan {
            exchange: "dlx".to_owned(),
            routing_key: "dead".to_owned(),
        };
        let delivery = delivery(BasicProperties::default());
        assert_eq!(
            plan.target_of(&delivery, DISPOSAL_DEAD_LETTER),
            ("dlx".to_owned(), "dead".to_owned())
        );
    }

    #[test]
    fn headers_are_converted_to_management_json() {
        // 管理 API 兜底路径要把 header 原样带过去，否则 trace-id 这类链路标记会丢。
        // 注意 header 表在管理 API 里是 properties 字段下的 `headers` 子对象，
        // 不是铺平在顶层 —— 铺平了服务端会当成未知属性忽略掉。
        let json = properties_to_json(&properties(&[("trace-id", "abc")]));
        assert_eq!(json["headers"]["trace-id"], serde_json::json!("abc"));
    }

    #[test]
    fn header_json_keeps_primitive_types() {
        let mut table = FieldTable::default();
        table.insert(
            ShortString::from("retries".to_owned()),
            AMQPValue::LongInt(3),
        );
        table.insert(ShortString::from("ok".to_owned()), AMQPValue::Boolean(true));
        let json = properties_to_json(&BasicProperties::default().with_headers(table));
        assert_eq!(json["headers"]["retries"], serde_json::json!(3));
        assert_eq!(json["headers"]["ok"], serde_json::json!(true));
    }

    #[test]
    fn fallback_publish_keeps_message_semantics() {
        // 关键回归：兜底发布以前只搬 headers，消息的「语义属性」全丢。
        // 后果不是投不出去，而是投出去的是另一条消息：TTL 没了、优先级没了、
        // 持久化标记没了 —— 每一处都没有报错。
        let original = BasicProperties::default()
            .with_content_type("application/json".into())
            .with_content_encoding("gzip".into())
            .with_delivery_mode(2)
            .with_priority(7)
            .with_expiration("60000".into())
            .with_message_id("m-1".into())
            .with_correlation_id("c-1".into())
            .with_reply_to("reply.queue".into())
            .with_timestamp(1_700_000)
            .with_type("order.created".into())
            .with_user_id("guest".into())
            .with_app_id("mqtui".into());

        let json = properties_to_json(&original);
        assert_eq!(json["content_type"], serde_json::json!("application/json"));
        assert_eq!(json["content_encoding"], serde_json::json!("gzip"));
        assert_eq!(json["message_id"], serde_json::json!("m-1"));
        assert_eq!(json["correlation_id"], serde_json::json!("c-1"));
        assert_eq!(json["reply_to"], serde_json::json!("reply.queue"));
        assert_eq!(json["expiration"], serde_json::json!("60000"));
        // `type` 是 AMQP 里 `kind` 的对外名字。
        assert_eq!(json["type"], serde_json::json!("order.created"));
        assert_eq!(json["user_id"], serde_json::json!("guest"));
        assert_eq!(json["app_id"], serde_json::json!("mqtui"));

        // 三个数值字段必须是数字：管理 API 的 to_basic_properties 对它们
        // 只认整数，传字符串会整条投递失败。
        assert_eq!(json["delivery_mode"], serde_json::json!(2));
        assert_eq!(json["priority"], serde_json::json!(7));
        assert_eq!(json["timestamp"], serde_json::json!(1_700_000));
        assert!(json["delivery_mode"].is_number());
        assert!(json["priority"].is_number());
        assert!(json["timestamp"].is_number());
    }

    #[test]
    fn fallback_publish_omits_absent_properties() {
        // 没有的属性不能写成空串：管理 API 会把空串当成「设成空」，
        // 而 expiration 空串在部分版本里会让消息立即过期。
        let json = properties_to_json(&BasicProperties::default());
        assert_eq!(json, serde_json::json!({}));
    }

    #[test]
    fn fallback_publish_drops_cluster_id() {
        // cluster_id 是集群内部路由标记，不属于「这条消息是谁」的语义，不带过去。
        let json =
            properties_to_json(&BasicProperties::default().with_cluster_id("cluster-1".into()));
        assert!(json.get("cluster_id").is_none());
    }
}
