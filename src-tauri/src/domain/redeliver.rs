//! RabbitMQ 消息的「事后处置」：把队列里的一条消息重新投递到交换机，
//! 或投进它所属的死信交换机。
//!
//! 这两个动作在 AMQP 里都不是原语——重投是「发布一份 + 把原消息 ack 掉」，
//! 移入死信是「发布一份到死信交换机 + 把原消息 reject（不重回队列）」。
//! 发布失败却已经把原消息丢掉，就等于凭空销毁了一条消息，所以顺序必须固定：
//! **先发布、确认落地，再处理原消息**。
//!
//! 规则（交换机名、routing key、不可操作的原因）都是纯函数，
//! 界面与命令层共用同一份判断，不依赖 broker 即可单测。

use serde::{Deserialize, Serialize};

use super::KeyValue;

/// 死信交换机参数名。
pub const DEAD_LETTER_EXCHANGE_KEY: &str = "x-dead-letter-exchange";
/// 死信 routing key 参数名。
pub const DEAD_LETTER_ROUTING_KEY_KEY: &str = "x-dead-letter-routing-key";
/// 默认交换机名（AMQP 里表现为空串）。
pub const DEFAULT_EXCHANGE: &str = "";

/// 消息的当前投递信息，由消息本身与服务端上报的 header 拼出。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryInfo {
    /// 当前所在队列。
    pub queue: String,
    /// 投递该消息的交换机，默认交换机为空串。
    pub exchange: String,
    /// 当前 routing key。
    pub routing_key: String,
    /// 是否已被投递过（`redelivered` 标记）。
    pub redelivered: bool,
    /// 原始交换机：消息从哪个交换机发出（`x-original-exchange`，不存在时不填）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_exchange: Option<String>,
    /// 原始 routing key（`x-original-routing-key`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_routing_key: Option<String>,
}

/// 队列声明的死信策略（来自 `/api/queues/{vhost}/{name}` 的 `arguments`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLetterPolicy {
    /// `x-dead-letter-exchange` 的原始取值，`None` 表示队列没配死信。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange: Option<String>,
    /// `x-dead-letter-routing-key` 的原始取值，`None` 表示沿用原 routing key。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_key: Option<String>,
}

impl DeadLetterPolicy {
    /// 从队列参数里解析死信策略。参数值已由管理 API 渲染成字符串。
    pub fn from_arguments(arguments: &[KeyValue]) -> Self {
        let find = |key: &str| {
            arguments
                .iter()
                .find(|item| item.key == key)
                .map(|item| item.value.clone())
        };
        Self {
            exchange: find(DEAD_LETTER_EXCHANGE_KEY),
            routing_key: find(DEAD_LETTER_ROUTING_KEY_KEY),
        }
    }

    /// 是否配置了死信交换机（空串是合法值，表示「死信给默认交换机」）。
    pub fn configured(&self) -> bool {
        self.exchange.is_some()
    }
}

/// 重新投递：把消息再发一次到某个交换机。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeliverRequest {
    pub connection_id: String,
    /// 消息 ID（`queue:deliveryTag`）。
    pub message_id: String,
    /// 目标交换机，空串表示默认交换机。
    #[serde(default)]
    pub exchange: String,
    /// 目标 routing key。留空时沿用消息原始 routing key。
    #[serde(default)]
    pub routing_key: String,
}

/// 把消息移入它所属的死信交换机。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadLetterRequest {
    pub connection_id: String,
    /// 消息 ID（`queue:deliveryTag`）。
    pub message_id: String,
}

/// 处置结果，回报「消息被送到了哪里」，而不是一句干巴巴的成功。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisposalOutcome {
    /// 动作名，用于界面提示（`redeliver` / `deadLetter`）。
    pub action: String,
    pub exchange: String,
    pub routing_key: String,
    /// 发布确认信息（publisher confirm 的返回）。
    pub detail: String,
}

/// 死信目标无法确定时的原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum DeadLetterBlock {
    /// 队列没有声明死信策略。
    NotConfigured,
    /// 目标交换机在拓扑里不存在（配置写错或已被删）。
    UnknownExchange(String),
}

impl DeadLetterBlock {
    /// 给界面看的一句话。
    pub fn reason(&self) -> String {
        match self {
            Self::NotConfigured => format!(
                "队列没有配置 {DEAD_LETTER_EXCHANGE_KEY}，消息不会被投进死信。\
                 想手动送进死信，请先给队列声明死信策略"
            ),
            Self::UnknownExchange(name) => {
                format!("队列声明的死信交换机 {name} 在当前拓扑里不存在，投进去会被静默丢弃")
            }
        }
    }
}

/// 一条消息当前能不能重投 / 移入死信。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisposalCapabilities {
    /// 消息是否还有 `x-death` 之外的已知原因导致不可重投（目前只用于展示）。
    pub can_redeliver: bool,
    pub can_dead_letter: bool,
    /// 不能操作的原因，`key` 是 `redeliver` / `deadLetter`。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasons: Vec<KeyValue>,
}

impl DisposalCapabilities {
    /// 重投永远可选（目标交换机由用户填），死信要看队列策略。
    pub fn evaluate(
        policy: &DeadLetterPolicy,
        known_exchanges: &[String],
    ) -> (bool, DeadLetterBlock) {
        let block = match policy.exchange.as_deref() {
            None => DeadLetterBlock::NotConfigured,
            Some(exchange) => {
                // 空串是默认交换机，不需要出现在 /api/exchanges 里。
                if exchange.is_empty() || known_exchanges.iter().any(|name| name == exchange) {
                    return (true, DeadLetterBlock::NotConfigured);
                }
                DeadLetterBlock::UnknownExchange(exchange.to_owned())
            }
        };
        (false, block)
    }
}

/// 重投的目标交换机与 routing key。
///
/// routing key 留空时**沿用消息的原始 routing key**：消息被转发过几次后
/// 当前 routing key 可能已经变成别的样子（比如经过 topic 交换机），
/// 想「原路再走一遍」的人要的是原始那个。
pub fn resolve_redeliver_target(
    delivery: &DeliveryInfo,
    request: &RedeliverRequest,
) -> (String, String) {
    let exchange = request.exchange.trim().to_owned();
    let routing_key = match request.routing_key.trim() {
        "" => delivery
            .original_routing_key
            .clone()
            .unwrap_or_else(|| delivery.routing_key.clone()),
        key => key.to_owned(),
    };
    (exchange, routing_key)
}

/// 死信目标：交换机来自队列策略，routing key 优先取队列声明的覆盖值，
/// 没配则沿用消息的原始 routing key（这是 RabbitMQ 自己的死信语义）。
pub fn resolve_dead_letter_target(
    delivery: &DeliveryInfo,
    policy: &DeadLetterPolicy,
) -> (String, String) {
    let exchange = policy.exchange.clone().unwrap_or_default();
    let routing_key = policy
        .routing_key
        .clone()
        .unwrap_or_else(|| delivery.routing_key.clone());
    (exchange, routing_key)
}

/// 批量处置：一次对若干条消息执行同一个动作。
///
/// 批量不能被当成「一次请求里跑 N 个单条处置」：只要有一条失败，整批就不可回滚，
/// 而前端只拿到一句错误提示，于是没人知道哪几条成了、哪几条没成。
/// 所以批量接口的返回值必须是**逐条结果**，而不是成败二选一。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDisposalRequest {
    pub connection_id: String,
    /// 动作名，与单条处置保持一致（`redeliver` / `deadLetter`）。
    pub action: String,
    /// 目标消息 ID 列表，顺序即回报顺序。
    pub message_ids: Vec<String>,
    /// 重投的目标交换机（仅 `redeliver` 使用），空串表示默认交换机。
    #[serde(default)]
    pub exchange: String,
    /// 重投的目标 routing key（仅 `redeliver` 使用），留空沿用各自消息的原始 routing key。
    #[serde(default)]
    pub routing_key: String,
    /// 「重试没放回队列的那批」时必填：它们所在的队列。
    ///
    /// 正常批量处置时留空（队列由消息 ID 推出来，且必须一致）；
    /// 重试的输入是上一轮结果里的 `stranded`，那是**用户没选中的那些消息**，
    /// 不能按「选中的那批」推队列 —— 它们是同一条队列里被顺带取出来的，
    /// 但队列名只有调用方知道（同一条队列里选了哪几条无关紧要）。
    #[serde(default)]
    pub queue: String,
}

/// 单条消息的批量处置结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDisposalItem {
    pub message_id: String,
    pub status: BatchItemStatus,
    /// 成功时是被送去的目标（`交换机 / routing key`），失败时是失败原因。
    pub detail: String,
}

/// 批量处置里单条消息的结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchItemStatus {
    /// 发布确认落地，原消息已从队列移除。
    Ok,
    /// 这条没成，原消息仍在队列里。
    Failed,
    /// 这一条根本没被执行：同一批里已经出现了失败，为避免「半截处置」提前停下。
    Skipped,
}

impl BatchItemStatus {
    /// 是否值得继续处理剩下的消息。
    ///
    /// `Skipped` 也返回 `false`：被跳过说明这一批已经停过，继续处理会让账户里
    /// 出现「前面几条被跳过、后面几条却做了」的混乱结果。
    pub fn should_continue(self) -> bool {
        self == Self::Ok
    }
}

/// 批量处置汇总。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDisposalOutcome {
    pub action: String,
    /// 逐条结果，顺序与请求里的 `message_ids` 一致。
    pub items: Vec<BatchDisposalItem>,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    /// 给界面顶部的一句话结论，避免用户自己去数三行数字。
    pub note: String,
    /// 顺带取出、却没能放回队列的消息 ID（`queue:deliveryTag`）。
    ///
    /// 这类消息不在 `items` 里（用户没选它们），但也没有回到队列：
    /// 它们仍被本次消费通道持有，连接关闭后才会被服务端退回。
    /// 归零之前不该让它静默 —— 那是一次「我什么都没选，怎么少了」的事故。
    ///
    /// 给的是**完整的 ID 列表**而不是一个计数：只有一个数字，界面除了说一句
    /// 「有 3 条卡住了」什么都做不了，用户只能干等连接关闭。带上 ID，
    /// 这一点（以及别的连接上）还能把它们找回来重新放回。
    ///
    /// ID 里的投递标签属于本次消费通道，通道关了就不再有意义 ——
    /// 重试走的是「按队列重新找一遍」那条路（见 `stranded_retry_ids`）。
    #[serde(default)]
    pub stranded: Vec<String>,
    /// 没放回队列的那些消息，能不能靠再点一次「重试这批」收回来。
    ///
    /// 这里的 `None` 与 `Some(false)` 是两件事：
    /// - `None`：没有卡住的消息，问题不成立；
    /// - `Some(false)`：确实有消息卡住了，但界面点不动 —— 得让人知道去哪儿处理，
    ///   而不是给一个按下去必然失败的按钮。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

impl BatchDisposalOutcome {
    /// 由逐条结果汇总出计数与结论。
    pub fn from_items(action: &str, items: Vec<BatchDisposalItem>) -> Self {
        let count =
            |status: BatchItemStatus| items.iter().filter(|item| item.status == status).count();
        let (succeeded, failed, skipped) = (
            count(BatchItemStatus::Ok),
            count(BatchItemStatus::Failed),
            count(BatchItemStatus::Skipped),
        );

        Self {
            action: action.to_owned(),
            note: summarize(succeeded, failed, skipped),
            items,
            succeeded,
            failed,
            skipped,
            stranded: Vec::new(),
            retryable: None,
        }
    }
}

/// 一批里最多处置多少条。
///
/// 批量处置是「先发布、再丢弃原消息」的串行流水线，每条都要一次发布确认；
/// 条数不设上限会让一次点击变成几百次往返，界面只能干等。
pub const MAX_BATCH_SIZE: usize = 50;

/// 校验请求并返回去重后的消息 ID（保持原顺序）。
///
/// 去重是必需的：前端多选时同一个投递标签可能出现两次（翻页追加后列表里存在重复行），
/// 而对同一条消息执行两次「先发布再丢弃」，第二条必然找不到、报一条让人困惑的失败。
pub fn normalize_batch(request: &BatchDisposalRequest) -> Result<Vec<String>, String> {
    if request.action != DISPOSAL_REDELIVER && request.action != DISPOSAL_DEAD_LETTER {
        return Err(format!(
            "未知的处置动作 {}，只支持 {DISPOSAL_REDELIVER} / {DISPOSAL_DEAD_LETTER}",
            request.action
        ));
    }

    let mut seen = std::collections::HashSet::new();
    let ids: Vec<String> = request
        .message_ids
        .iter()
        .filter(|id| !id.trim().is_empty())
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect();

    if ids.is_empty() {
        return Err("请至少选择一条消息".to_owned());
    }
    if ids.len() > MAX_BATCH_SIZE {
        return Err(format!(
            "一次最多处置 {MAX_BATCH_SIZE} 条，当前选中 {} 条",
            ids.len()
        ));
    }
    Ok(ids)
}

/// 处置动作名：重新投递。
pub const DISPOSAL_REDELIVER: &str = "redeliver";
/// 处置动作名：移入死信。
pub const DISPOSAL_DEAD_LETTER: &str = "deadLetter";

/// 重试一批没放回队列的消息时，最多接受多少个 ID。
///
/// 比 `MAX_BATCH_SIZE` 宽得多：重试只做一次 `basic.reject(requeue)`，不发布、
/// 不分批串行，代价与条数基本无关。上限只用来挡住明显异常的输入。
pub const MAX_STRANDED_RETRY: usize = 500;

/// 从「没放回队列」的 ID 里挑出这一次真正要重试的。
///
/// 游标里记的投递标签属于**当时那条消费通道**，通道一关就换了号；所以重试
/// 不是「按标签找回原来那一条」，而是「按队列重新找一遍」——
/// 与单条处置、批量处置同一条路（`take_target` 拿不到就明确报「已不在队列」）。
///
/// 因此这里的过滤规则是：队列名必须对得上，标签必须是正数。
/// 标签对不上是**正常**的（消息已被消费、或换了通道），不该在发起前就判死。
pub fn stranded_retry_ids(queue: &str, ids: &[String]) -> Result<Vec<String>, String> {
    let queue = queue.trim();
    if queue.is_empty() {
        return Err("请填写消息所在的队列".to_owned());
    }

    let mut seen = std::collections::HashSet::new();
    let selected: Vec<String> = ids
        .iter()
        .filter(|id| !id.trim().is_empty())
        .filter(|id| seen.insert((*id).clone()))
        .cloned()
        .collect();

    if selected.is_empty() {
        return Err("没有需要重试的消息".to_owned());
    }
    if selected.len() > MAX_STRANDED_RETRY {
        return Err(format!(
            "一次最多重试 {MAX_STRANDED_RETRY} 条，当前 {} 条",
            selected.len()
        ));
    }
    for id in &selected {
        let (in_queue, tag) = id
            .rsplit_once(':')
            .ok_or_else(|| format!("非法的消息 ID: {id}"))?;
        if in_queue != queue {
            return Err(format!(
                "消息 {id} 不在队列 {queue} 里：一次只能重试同一个队列的消息"
            ));
        }
        match tag.parse::<u64>() {
            Ok(tag) if tag > 0 => {}
            _ => return Err(format!("非法的消息 ID: {id}")),
        }
    }
    Ok(selected)
}

/// 把三个计数说成一句人话。三种结局都要出现，哪怕是 0。
///
/// 「成功 3 条」这种只报喜悦的文案，在「3 成 2 败」时会把失败藏起来。
fn summarize(succeeded: usize, failed: usize, skipped: usize) -> String {
    if failed == 0 && skipped == 0 {
        return format!("全部成功：{succeeded} 条");
    }
    if succeeded == 0 && failed == 0 {
        return format!("没有执行：{skipped} 条被跳过");
    }
    format!("成功 {succeeded} 条，失败 {failed} 条，跳过 {skipped} 条")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delivery(exchange: &str, routing_key: &str) -> DeliveryInfo {
        DeliveryInfo {
            queue: "orders".to_owned(),
            exchange: exchange.to_owned(),
            routing_key: routing_key.to_owned(),
            redelivered: false,
            original_exchange: None,
            original_routing_key: None,
        }
    }

    fn request(exchange: &str, routing_key: &str) -> RedeliverRequest {
        RedeliverRequest {
            connection_id: "c".to_owned(),
            message_id: "orders:1".to_owned(),
            exchange: exchange.to_owned(),
            routing_key: routing_key.to_owned(),
        }
    }

    #[test]
    fn policy_parses_dead_letter_arguments() {
        let policy = DeadLetterPolicy::from_arguments(&[
            KeyValue::new(DEAD_LETTER_EXCHANGE_KEY, "dlx"),
            KeyValue::new(DEAD_LETTER_ROUTING_KEY_KEY, "dead"),
        ]);
        assert_eq!(policy.exchange.as_deref(), Some("dlx"));
        assert_eq!(policy.routing_key.as_deref(), Some("dead"));
        assert!(policy.configured());
    }

    #[test]
    fn policy_absent_means_not_configured() {
        let policy = DeadLetterPolicy::from_arguments(&[KeyValue::new("x-max-length", "10")]);
        assert!(!policy.configured());
        assert_eq!(
            DisposalCapabilities::evaluate(&policy, &[]),
            (false, DeadLetterBlock::NotConfigured)
        );
    }

    #[test]
    fn empty_dead_letter_exchange_is_default_exchange_and_allowed() {
        let policy =
            DeadLetterPolicy::from_arguments(&[KeyValue::new(DEAD_LETTER_EXCHANGE_KEY, "")]);
        assert!(policy.configured());
        assert_eq!(
            DisposalCapabilities::evaluate(&policy, &[]),
            (true, DeadLetterBlock::NotConfigured)
        );
    }

    #[test]
    fn unknown_dead_letter_exchange_is_blocked() {
        let policy =
            DeadLetterPolicy::from_arguments(&[KeyValue::new(DEAD_LETTER_EXCHANGE_KEY, "dlx")]);
        let (allowed, block) = DisposalCapabilities::evaluate(&policy, &["other".to_owned()]);
        assert!(!allowed);
        assert_eq!(block, DeadLetterBlock::UnknownExchange("dlx".to_owned()));
        assert!(block.reason().contains("dlx"));
    }

    #[test]
    fn known_dead_letter_exchange_is_allowed() {
        let policy =
            DeadLetterPolicy::from_arguments(&[KeyValue::new(DEAD_LETTER_EXCHANGE_KEY, "dlx")]);
        assert!(DisposalCapabilities::evaluate(&policy, &["dlx".to_owned()]).0);
    }

    #[test]
    fn redeliver_target_defaults_to_original_routing_key() {
        let mut info = delivery("ex", "current");
        info.original_routing_key = Some("original".to_owned());

        assert_eq!(
            resolve_redeliver_target(&info, &request("ex", "")),
            ("ex".to_owned(), "original".to_owned())
        );
        assert_eq!(
            resolve_redeliver_target(&info, &request("ex", "  ")),
            ("ex".to_owned(), "original".to_owned())
        );
        // 用户填了就用用户的，包括空格要去掉。
        assert_eq!(
            resolve_redeliver_target(&info, &request("ex", " manual ")),
            ("ex".to_owned(), "manual".to_owned())
        );
    }

    #[test]
    fn redeliver_target_falls_back_to_current_routing_key() {
        assert_eq!(
            resolve_redeliver_target(&delivery("ex", "current"), &request("", "")),
            (String::new(), "current".to_owned())
        );
    }

    #[test]
    fn dead_letter_target_prefers_policy_routing_key() {
        let info = delivery("ex", "current");
        let policy = DeadLetterPolicy {
            exchange: Some("dlx".to_owned()),
            routing_key: Some("dead".to_owned()),
        };
        assert_eq!(
            resolve_dead_letter_target(&info, &policy),
            ("dlx".to_owned(), "dead".to_owned())
        );

        let policy = DeadLetterPolicy {
            exchange: Some("dlx".to_owned()),
            routing_key: None,
        };
        assert_eq!(
            resolve_dead_letter_target(&info, &policy),
            ("dlx".to_owned(), "current".to_owned())
        );
    }

    fn batch_request(action: &str, ids: &[&str]) -> BatchDisposalRequest {
        BatchDisposalRequest {
            connection_id: "c".to_owned(),
            action: action.to_owned(),
            message_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            exchange: String::new(),
            routing_key: String::new(),
            queue: String::new(),
        }
    }

    #[test]
    fn batch_rejects_unknown_action() {
        assert!(normalize_batch(&batch_request("purge", &["orders:1"])).is_err());
    }

    #[test]
    fn batch_rejects_empty_selection() {
        // 全是空白也算没选：多选后清空不该变成一次空跑。
        let error = normalize_batch(&batch_request(DISPOSAL_REDELIVER, &["", "  "])).unwrap_err();
        assert!(error.contains("至少选择一条"));
    }

    #[test]
    fn batch_deduplicates_while_keeping_order() {
        // 同一条消息被处置两次，第二次必然找不到——去重而不是让它报一条费解的失败。
        let ids = normalize_batch(&batch_request(
            DISPOSAL_DEAD_LETTER,
            &["orders:3", "orders:1", "orders:3"],
        ))
        .expect("应当通过");
        assert_eq!(ids, vec!["orders:3".to_owned(), "orders:1".to_owned()]);
    }

    #[test]
    fn batch_caps_size() {
        let ids: Vec<String> = (0..MAX_BATCH_SIZE + 1).map(|i| format!("q:{i}")).collect();
        let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
        let error = normalize_batch(&batch_request(DISPOSAL_REDELIVER, &borrowed)).unwrap_err();
        assert!(error.contains(&MAX_BATCH_SIZE.to_string()));
    }

    fn item(id: &str, status: BatchItemStatus) -> BatchDisposalItem {
        BatchDisposalItem {
            message_id: id.to_owned(),
            status,
            detail: String::new(),
        }
    }

    #[test]
    fn batch_outcome_counts_every_status() {
        let outcome = BatchDisposalOutcome::from_items(
            DISPOSAL_DEAD_LETTER,
            vec![
                item("q:1", BatchItemStatus::Ok),
                item("q:2", BatchItemStatus::Ok),
                item("q:3", BatchItemStatus::Failed),
                item("q:4", BatchItemStatus::Skipped),
            ],
        );
        assert_eq!(
            (outcome.succeeded, outcome.failed, outcome.skipped),
            (2, 1, 1)
        );
        // 结论里三种结局都要出现，不能只报成功数。
        assert!(outcome.note.contains("成功 2 条"));
        assert!(outcome.note.contains("失败 1 条"));
        assert!(outcome.note.contains("跳过 1 条"));
    }

    #[test]
    fn batch_outcome_all_ok_reads_cleanly() {
        let outcome = BatchDisposalOutcome::from_items(
            DISPOSAL_REDELIVER,
            vec![item("q:1", BatchItemStatus::Ok)],
        );
        assert_eq!(outcome.note, "全部成功：1 条");
    }

    #[test]
    fn batch_outcome_all_skipped_is_not_reported_as_success() {
        let outcome = BatchDisposalOutcome::from_items(
            DISPOSAL_REDELIVER,
            vec![
                item("q:1", BatchItemStatus::Skipped),
                item("q:2", BatchItemStatus::Skipped),
            ],
        );
        assert_eq!(outcome.note, "没有执行：2 条被跳过");
        assert!(!outcome.note.contains("成功"));
    }

    #[test]
    fn only_ok_continues_the_batch() {
        assert!(BatchItemStatus::Ok.should_continue());
        assert!(!BatchItemStatus::Failed.should_continue());
        // 被跳过说明这一批已经停过，继续处理会造成「前跳过、后执行」的错乱结果。
        assert!(!BatchItemStatus::Skipped.should_continue());
    }
    #[test]
    fn stranded_retry_keeps_order_and_dedups() {
        let ids = stranded_retry_ids(
            "orders",
            &[
                "orders:7".to_owned(),
                "orders:3".to_owned(),
                "orders:7".to_owned(),
                " ".to_owned(),
            ],
        )
        .expect("应当通过");
        assert_eq!(ids, vec!["orders:7".to_owned(), "orders:3".to_owned()]);
    }

    #[test]
    fn stranded_retry_rejects_other_queues() {
        // 一次只处理一个队列：混着来就没法说清「为什么从这条队列里取」。
        let error = stranded_retry_ids("orders", &["payments:3".to_owned()]).unwrap_err();
        assert!(error.contains("不在队列 orders"));
    }

    #[test]
    fn stranded_retry_keeps_colon_in_queue_name() {
        // 队列名可以带冒号，按最后一个冒号切。
        let ids = stranded_retry_ids("sys:logs", &["sys:logs:42".to_owned()]).expect("应当通过");
        assert_eq!(ids, vec!["sys:logs:42".to_owned()]);
    }

    #[test]
    fn stranded_retry_rejects_junk_tags() {
        assert!(stranded_retry_ids("orders", &["orders:abc".to_owned()]).is_err());
        // 投递标签从 1 开始，0 不可能是真实标签。
        assert!(stranded_retry_ids("orders", &["orders:0".to_owned()]).is_err());
        assert!(stranded_retry_ids("orders", &["orders".to_owned()]).is_err());
        assert!(stranded_retry_ids("", &["orders:1".to_owned()]).is_err());
        assert!(stranded_retry_ids("orders", &[]).is_err());
    }
}
