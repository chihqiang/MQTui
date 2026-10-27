//! RabbitMQ 策略（policy）与参数（parameter / operator policy）的校验与后果说明。
//!
//! 这一层是面板里改得最频繁、也最容易出事的地方：TTL、死信、镜像、队列长度上限
//! 全靠 policy 下发。错的不是「能不能改」，而是**改完之后影响谁**——
//! 一个 `apply-to: all` 的 TTL 会同时命中所有匹配队列，包括那些本来不打算动的。
//!
//! 所以规则都收成纯函数，分四件事：
//! 1. 名称与匹配模式（pattern）能不能提交；
//! 2. 生效范围（`apply-to`）落到哪些资源上，界面必须写出来；
//! 3. `priority` 的冲突提示：同范围内优先级高者胜，低优先级的策略会**静默失效**；
//! 4. 参数值的类型规整——`x-message-ttl` 必须是整数，`ha-mode` 只能是几个固定值。
//!
//! 不碰网络，全部可单测。前端对应 `src/lib/policy.ts`。

use serde::{Deserialize, Serialize};

/// 策略生效范围。RabbitMQ 用 `apply-to` 表达，取值固定为三者之一。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PolicyApplyTo {
    /// 只对队列生效。
    Queues,
    /// 只对交换机生效。
    Exchanges,
    /// 队列与交换机都生效——最容易误伤相邻资源的那一档。
    All,
}

impl PolicyApplyTo {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Queues => "queues",
            Self::Exchanges => "exchanges",
            Self::All => "all",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "queues" => Some(Self::Queues),
            "exchanges" => Some(Self::Exchanges),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    /// 生效范围的说明，界面直接展示。
    pub const fn describe(self) -> &'static str {
        match self {
            Self::Queues => "只作用于匹配的队列",
            Self::Exchanges => "只作用于匹配的交换机",
            Self::All => "同时作用于匹配的队列与交换机",
        }
    }
}

/// 一条策略的领域模型。字段与管理 API 的 `GET /api/policies/{vhost}` 对齐。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyInfo {
    pub name: String,
    pub vhost: String,
    /// 正则，命中名称的资源才应用这条策略。
    pub pattern: String,
    /// 数字越大越优先。同范围同优先级时服务端拒绝提交。
    pub priority: i32,
    pub apply_to: PolicyApplyTo,
    /// `definition` 里的键值对，例如 `ha-mode=all`、`x-message-ttl=60000`。
    pub definition: Vec<DefinitionEntry>,
}

/// 策略定义中的一个键值。值统一渲染成字符串展示，提交时再按类型还原。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionEntry {
    pub key: String,
    pub value: String,
}

/// 新建 / 修改策略的请求。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySpec {
    pub name: String,
    /// 留空等于 `.*`：匹配全部资源。服务端也接受空串，但语义不明显，界面上要写清。
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub priority: i32,
    pub apply_to: PolicyApplyTo,
    #[serde(default)]
    pub definition: Vec<DefinitionEntry>,
}

impl PolicySpec {
    /// 提交前的本地校验。返回的错误可直接展示。
    ///
    /// 这里只拦「服务端必然拒绝」和「语义会让人误解」两类问题：
    /// 正则语法是否正确交给服务端，本地不做正则编译——两边规则不一致时
    /// 本地放行、服务端报错，比本地先错杀好。
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("策略名称不能为空".to_owned());
        }
        // 策略名允许几乎所有字符，但空白的首尾会被服务端当成另一个名字。
        if self.name.trim() != self.name {
            return Err("策略名称首尾不能有空白字符".to_owned());
        }
        if self.definition.is_empty() {
            return Err("策略至少要包含一项定义，否则规则不产生任何效果".to_owned());
        }
        for entry in &self.definition {
            let key = entry.key.trim();
            if key.is_empty() {
                return Err("定义项的键不能为空".to_owned());
            }
            if entry.key != key {
                return Err(format!("定义项的键 `{}` 首尾不能有空白字符", entry.key));
            }
            normalize_value(key, &entry.value)?;
        }
        Ok(())
    }

    /// 这条策略在什么情况下会「看起来生效了，实际没生效」。
    ///
    /// 这是确认框里必须出现的一句话：策略是声明式的，改了不等价于立刻起作用——
    /// 已有的队列要等下次声明（或重新打开）才会套用新参数。
    pub fn caveats(&self) -> Vec<String> {
        let mut notes = Vec::new();
        let pattern = effective_pattern(&self.pattern);
        if pattern == ".*" {
            notes.push("匹配模式为空，等价于 `.*`：会命中当前及以后创建的全部资源".to_owned());
        }
        match self.apply_to {
            PolicyApplyTo::All => {
                notes.push("生效范围是队列 + 交换机，同名资源会一起被改".to_owned());
            }
            PolicyApplyTo::Queues if self.touches_exchange_only_key() => {
                notes.push(
                    "定义里有只对交换机有效的项（如 `alternate-exchange`），对队列不产生效果"
                        .to_owned(),
                );
            }
            _ => {}
        }
        notes.push(
            "策略只对「之后声明」的资源生效：已存在的队列要重新声明或重启消费者才会套用".to_owned(),
        );
        notes
    }

    fn touches_exchange_only_key(&self) -> bool {
        self.definition
            .iter()
            .any(|entry| EXCHANGE_ONLY_KEYS.contains(&entry.key.trim()))
    }
}

/// 只对交换机有意义的策略键。写进 `apply-to: queues` 不会报错，只是什么都不做。
const EXCHANGE_ONLY_KEYS: &[&str] = &["alternate-exchange"];

/// 空模式按 `.*` 处理。管理 API 自己也这么做，但界面上必须写出来。
pub fn effective_pattern(pattern: &str) -> &str {
    if pattern.trim().is_empty() {
        ".*"
    } else {
        pattern.trim()
    }
}

/// 已知策略键的取值约束。不在表里的键按字符串透传——RabbitMQ 插件会注册自己的键，
/// 本地白名单拦下来会挡住合法用法。
///
/// 返回值经过规整（整数去掉前导零、枚举小写化），供提交时使用。
pub fn normalize_value(key: &str, raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("`{key}` 的值不能为空；不想要这一项请直接删除该行"));
    }

    // 严格相等，不做前缀 / 包含匹配：`x-max-length-bytes` 里含有 `x-max-length`，
    // 按前缀判断会把它当成整数项，于是一个合法的字节数上限被判成「必须是整数」。
    // 每加一个键都要问自己一次：它会不会是别的键的子串。
    let integer = matches!(
        key,
        "x-message-ttl"
            | "x-expires"
            | "x-max-length"
            | "x-max-length-bytes"
            | "x-max-priority"
            | "x-delivery-limit"
            | "message-ttl"
            | "expires"
            | "max-length"
            | "max-length-bytes"
            | "max-priority"
            | "delivery-limit"
    );
    if integer {
        // `x-message-ttl` 等内容为「毫秒」的项不接受负数；RabbitMQ 会直接 400。
        let parsed: i64 = value
            .parse()
            .map_err(|_| format!("`{key}` 必须是整数，当前值 `{value}`"))?;
        if parsed < 0 {
            return Err(format!("`{key}` 不能为负数，当前值 `{value}`"));
        }
        return Ok(parsed.to_string());
    }

    // 布尔项同样严格相等。`x-queue-master-locator` 不是布尔值（取值是
    // min-masters / client-local / random），把它列进来会让合法值全部报错。
    let boolean = matches!(key, "x-single-active-consumer");
    if boolean {
        return match value.to_ascii_lowercase().as_str() {
            "true" | "false" => Ok(value.to_ascii_lowercase()),
            _ => Err(format!("`{key}` 只接受 true / false，当前值 `{value}`")),
        };
    }

    // 队列主节点定位策略：固定枚举，写错不会报错但策略空转。
    if key == "x-queue-master-locator" {
        return match value {
            "min-masters" | "client-local" | "random" => Ok(value.to_owned()),
            _ => Err(format!(
                "`x-queue-master-locator` 只接受 min-masters / client-local / random，当前值 `{value}`"
            )),
        };
    }

    // 镜像相关的键：`ha-mode` 是固定枚举，写错不会报错但策略空转。
    if key == "ha-mode" {
        return match value {
            "all" | "exactly" | "nodes" => Ok(value.to_owned()),
            _ => Err(format!(
                "`ha-mode` 只接受 all / exactly / nodes，当前值 `{value}`"
            )),
        };
    }

    Ok(value.to_owned())
}

/// 队列溢出行为。这一档会直接改变「消息丢了还是卡住」，界面需要显式提示。
pub fn overflow_hint(key: &str, value: &str) -> Option<&'static str> {
    if key != "x-overflow" {
        return None;
    }
    match value {
        "drop-head" => Some("超出上限时丢弃最老的消息——数据会真的消失"),
        "reject-publish" => Some("超出上限时拒绝新的发布，发布方会收到 nack"),
        "reject-publish-dlx" => Some("超出上限时把新消息转投死信交换机"),
        _ => None,
    }
}

/// 策略与其它策略的优先级关系说明。
///
/// RabbitMQ 的规则是：同 `apply-to` 范围内，`priority` 高者胜。
/// 也就是说低优先级的策略**不会报错，只是不生效**——这是排查
/// 「我明明配了 TTL 却没生效」时最常见的答案，所以必须提前说出来。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorityConflict {
    /// 被压制的策略名。
    pub name: String,
    pub priority: i32,
    /// 说明文案。
    pub detail: String,
}

/// 计算当前策略会被哪些既有策略压制。
///
/// `others` 是同 vhost 的其它策略。只比较 `apply_to` 相交且优先级更高的那些：
/// `queues` 与 `exchanges` 两条策略互不影响，不应互相报警。
pub fn suppressed_by(spec: &PolicySpec, others: &[PolicyInfo]) -> Vec<PriorityConflict> {
    others
        .iter()
        .filter(|other| other.name != spec.name)
        .filter(|other| applies_intersect(spec.apply_to, other.apply_to))
        .filter(|other| other.priority > spec.priority)
        .map(|other| PriorityConflict {
            name: other.name.clone(),
            priority: other.priority,
            detail: format!(
                "`{}`（优先级 {}）覆盖同一范围，同名资源上本条策略不会生效",
                other.name, other.priority
            ),
        })
        .collect()
}

const fn applies_intersect(left: PolicyApplyTo, right: PolicyApplyTo) -> bool {
    matches!(
        (left, right),
        (PolicyApplyTo::All, _)
            | (_, PolicyApplyTo::All)
            | (PolicyApplyTo::Queues, PolicyApplyTo::Queues)
            | (PolicyApplyTo::Exchanges, PolicyApplyTo::Exchanges)
    )
}

/// 删除前的判定。策略的删除很安全（只是停止下发），所以几乎总允许；
/// 唯一的例外是名称非法——那说明数据脏了，硬删会把问题藏起来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyRemoval {
    Allowed,
    /// 名称为空：无法定位，服务端也会拒绝。
    BlankName,
}

impl PolicyRemoval {
    pub fn evaluate(name: &str) -> Self {
        if name.trim().is_empty() {
            Self::BlankName
        } else {
            Self::Allowed
        }
    }

    pub const fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    pub const fn reason(self) -> Option<&'static str> {
        match self {
            Self::Allowed => None,
            Self::BlankName => Some("策略名称为空，无法定位这条策略"),
        }
    }
}

/// 操作员策略（operator policy）的领域模型。
///
/// 它和普通 policy 长得像，但语义完全不同：普通 policy 由用户定义、可被更高优先级覆盖，
/// operator policy 由运维下发、**用户无法覆盖**，用来兜住「谁都不许设无上限队列」这类底线。
/// 所以界面上两者必须分开，混在一起会让人误以为能随手改掉。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorPolicyInfo {
    pub name: String,
    pub vhost: String,
    pub pattern: String,
    pub priority: i32,
    pub apply_to: PolicyApplyTo,
    pub definition: Vec<DefinitionEntry>,
}

/// 策略页的整体快照。一次拉全，避免前端串三个请求。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySnapshot {
    pub policies: Vec<PolicyInfo>,
    pub operator_policies: Vec<OperatorPolicyInfo>,
    /// 拉取操作员策略失败时的原因（老版本 RabbitMQ 没有这个接口）。
    ///
    /// 单独一个字段而不是整页报错：普通策略是这页的主体，不该因为
    /// 一个可选的补充信息拉不到就整页崩掉。
    pub operator_error: Option<String>,
}

/// 按模式粗略估算这条策略会命中多少资源，用于确认框里的「影响面」。
///
/// 这里只做子串/前后缀的启发式匹配，不编译正则：目标是给一个数量级，
/// 不是精确结果。真正的命中判定在服务端，面板估错了反而更糟，
/// 所以结果带 `exact: false` 标记，界面上写「约」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactEstimate {
    pub queues: usize,
    pub exchanges: usize,
    pub exact: bool,
}

/// 估算影响面。`pattern` 为空 / `.*` 时直接返回全量。
pub fn estimate_impact(
    pattern: &str,
    apply_to: PolicyApplyTo,
    queue_names: &[String],
    exchange_names: &[String],
) -> ImpactEstimate {
    let pattern = effective_pattern(pattern);
    // `.*` 与 `^.*$` 这类全匹配直接走全量，省得逐个试。
    let blanket = matches!(pattern, ".*" | "^.*$" | "");
    let hit =
        |name: &str| blanket || name.contains(pattern.trim_matches(&['^', '$', '.', '*'][..]));

    let queues = match apply_to {
        PolicyApplyTo::Queues | PolicyApplyTo::All => {
            queue_names.iter().filter(|name| hit(name)).count()
        }
        PolicyApplyTo::Exchanges => 0,
    };
    let exchanges = match apply_to {
        PolicyApplyTo::Exchanges | PolicyApplyTo::All => {
            exchange_names.iter().filter(|name| hit(name)).count()
        }
        PolicyApplyTo::Queues => 0,
    };

    ImpactEstimate {
        queues,
        exchanges,
        exact: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_bytes_is_not_confused_with_max_length() {
        // 回归：`x-max-length-bytes` 里含有 `x-max-length`，按前缀判断会把它
        // 当成整数项——一个合法的字节数上限因此被判成「必须是整数」。
        assert_eq!(
            normalize_value("x-max-length-bytes", "1048576").as_deref(),
            Ok("1048576")
        );
        assert_eq!(
            normalize_value("x-max-length", "1048576").as_deref(),
            Ok("1048576")
        );
        // 字节上限也必须是整数（RabbitMQ 会 400），但不是因为它「长得像」条数上限。
        assert!(normalize_value("x-max-length-bytes", "1MB").is_err());
        assert!(normalize_value("x-max-length-bytes", "-1").is_err());
    }

    #[test]
    fn queue_master_locator_is_an_enum_not_a_boolean() {
        // 它的取值是 min-masters / client-local / random，当成布尔会全部报错。
        for value in ["min-masters", "client-local", "random"] {
            assert_eq!(
                normalize_value("x-queue-master-locator", value).as_deref(),
                Ok(value)
            );
        }
        assert!(normalize_value("x-queue-master-locator", "nearest").is_err());
        // 真正是布尔的那一项仍然只认 true / false。
        assert_eq!(
            normalize_value("x-single-active-consumer", "TRUE").as_deref(),
            Ok("true")
        );
        assert!(normalize_value("x-single-active-consumer", "yes").is_err());
    }

    fn entry(key: &str, value: &str) -> DefinitionEntry {
        DefinitionEntry {
            key: key.to_owned(),
            value: value.to_owned(),
        }
    }

    fn spec(
        pattern: &str,
        apply_to: PolicyApplyTo,
        definition: Vec<DefinitionEntry>,
    ) -> PolicySpec {
        PolicySpec {
            name: "p".to_owned(),
            pattern: pattern.to_owned(),
            priority: 0,
            apply_to,
            definition,
        }
    }

    #[test]
    fn name_and_definition_are_required() {
        let blank = PolicySpec {
            name: "  ".to_owned(),
            ..spec(
                ".*",
                PolicyApplyTo::Queues,
                vec![entry("x-message-ttl", "1")],
            )
        };
        assert!(blank.validate().is_err());

        let padded = PolicySpec {
            name: " p ".to_owned(),
            ..spec(
                ".*",
                PolicyApplyTo::Queues,
                vec![entry("x-message-ttl", "1")],
            )
        };
        assert!(padded.validate().is_err());

        // 空定义等于配了个什么都不做的策略，比报错更容易让人困惑。
        let empty = spec(".*", PolicyApplyTo::Queues, Vec::new());
        assert!(empty.validate().is_err());
    }

    #[test]
    fn integer_values_are_normalized_and_reject_negative() {
        assert_eq!(normalize_value("x-message-ttl", " 007 ").unwrap(), "7");
        assert!(normalize_value("x-message-ttl", "-1").is_err());
        assert!(normalize_value("x-max-length", "abc").is_err());
        // 未知键按字符串透传：插件会注册自己的键，白名单拦下来会挡住合法用法。
        assert_eq!(normalize_value("x-custom-thing", "a b").unwrap(), "a b");
    }

    #[test]
    fn boolean_and_enum_values_are_checked() {
        assert_eq!(
            normalize_value("x-single-active-consumer", "TRUE").unwrap(),
            "true"
        );
        assert!(normalize_value("x-single-active-consumer", "yes").is_err());
        assert_eq!(normalize_value("ha-mode", "nodes").unwrap(), "nodes");
        assert!(normalize_value("ha-mode", "all-nodes").is_err());
    }

    #[test]
    fn blank_value_tells_user_to_delete_the_row() {
        let error = normalize_value("x-message-ttl", "   ").unwrap_err();
        assert!(error.contains("删除该行"), "实际文案：{error}");
    }

    #[test]
    fn empty_pattern_is_reported_as_blanket_match() {
        let notes = spec("", PolicyApplyTo::Queues, vec![entry("x-expires", "1000")]).caveats();
        assert!(notes.iter().any(|note| note.contains(".*")));
        // 无论何种情况都要说明「只对之后声明的资源生效」。
        assert!(notes.iter().any(|note| note.contains("之后声明")));
    }

    #[test]
    fn queues_scope_flags_exchange_only_definition() {
        let notes = spec(
            "orders",
            PolicyApplyTo::Queues,
            vec![entry("alternate-exchange", "ae")],
        )
        .caveats();
        assert!(notes.iter().any(|note| note.contains("alternate-exchange")));

        // apply-to: all 时这条键是有意义的，不该报警。
        let notes = spec(
            "orders",
            PolicyApplyTo::All,
            vec![entry("alternate-exchange", "ae")],
        )
        .caveats();
        assert!(!notes.iter().any(|note| note.contains("alternate-exchange")));
    }

    #[test]
    fn suppressed_by_only_compares_intersecting_scope() {
        let mine = PolicySpec {
            name: "mine".to_owned(),
            ..spec(
                "orders",
                PolicyApplyTo::Queues,
                vec![entry("x-expires", "1")],
            )
        };
        let others = vec![
            PolicyInfo {
                name: "strong-queues".to_owned(),
                vhost: "/".to_owned(),
                pattern: ".*".to_owned(),
                priority: 10,
                apply_to: PolicyApplyTo::Queues,
                definition: Vec::new(),
            },
            // 范围不相交，不应报警。
            PolicyInfo {
                name: "strong-exchanges".to_owned(),
                vhost: "/".to_owned(),
                pattern: ".*".to_owned(),
                priority: 20,
                apply_to: PolicyApplyTo::Exchanges,
                definition: Vec::new(),
            },
            // 优先级更低，不构成压制。
            PolicyInfo {
                name: "weak".to_owned(),
                vhost: "/".to_owned(),
                pattern: ".*".to_owned(),
                priority: 0,
                apply_to: PolicyApplyTo::All,
                definition: Vec::new(),
            },
            // 自己不算。
            PolicyInfo {
                name: "mine".to_owned(),
                vhost: "/".to_owned(),
                pattern: ".*".to_owned(),
                priority: 99,
                apply_to: PolicyApplyTo::Queues,
                definition: Vec::new(),
            },
        ];

        let conflicts = suppressed_by(&mine, &others);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].name, "strong-queues");
    }

    #[test]
    fn apply_to_all_intersects_with_everything() {
        let mine = PolicySpec {
            name: "mine".to_owned(),
            ..spec("x", PolicyApplyTo::All, vec![entry("x-expires", "1")])
        };
        let others = vec![PolicyInfo {
            name: "exchange-only".to_owned(),
            vhost: "/".to_owned(),
            pattern: ".*".to_owned(),
            priority: 5,
            apply_to: PolicyApplyTo::Exchanges,
            definition: Vec::new(),
        }];
        assert_eq!(suppressed_by(&mine, &others).len(), 1);
    }

    #[test]
    fn impact_estimate_respects_scope() {
        let queues = vec![
            "orders.new".to_owned(),
            "orders.old".to_owned(),
            "other".to_owned(),
        ];
        let exchanges = vec!["orders.ex".to_owned()];

        let all = estimate_impact("orders", PolicyApplyTo::All, &queues, &exchanges);
        assert_eq!(all.queues, 2);
        assert_eq!(all.exchanges, 1);
        assert!(!all.exact);

        let only_queues = estimate_impact("orders", PolicyApplyTo::Queues, &queues, &exchanges);
        assert_eq!(only_queues.exchanges, 0);

        // 空模式命中全部。
        let blanket = estimate_impact("", PolicyApplyTo::All, &queues, &exchanges);
        assert_eq!(blanket.queues, 3);
        assert_eq!(blanket.exchanges, 1);
    }

    #[test]
    fn removal_only_blocks_blank_names() {
        assert!(PolicyRemoval::evaluate("ha-all").is_allowed());
        assert!(!PolicyRemoval::evaluate(" ").is_allowed());
        assert!(PolicyRemoval::evaluate(" ").reason().is_some());
    }

    #[test]
    fn overflow_hint_covers_three_modes() {
        assert!(overflow_hint("x-overflow", "drop-head").is_some());
        assert!(overflow_hint("x-overflow", "reject-publish").is_some());
        assert!(overflow_hint("x-overflow", "reject-publish-dlx").is_some());
        assert!(overflow_hint("x-message-ttl", "drop-head").is_none());
    }

    #[test]
    fn apply_to_round_trips() {
        for scope in [
            PolicyApplyTo::Queues,
            PolicyApplyTo::Exchanges,
            PolicyApplyTo::All,
        ] {
            assert_eq!(PolicyApplyTo::parse(scope.as_str()), Some(scope));
            assert!(!scope.describe().is_empty());
        }
        assert_eq!(PolicyApplyTo::parse("nodes"), None);
    }
}
