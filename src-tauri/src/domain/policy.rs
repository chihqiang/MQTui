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
        if self.apply_to == PolicyApplyTo::All {
            notes.push("生效范围是队列 + 交换机，同名资源会一起被改".to_owned());
        }
        notes.extend(self.definition_caveats());
        notes.push(
            "策略只对「之后声明」的资源生效：已存在的队列要重新声明或重启消费者才会套用".to_owned(),
        );
        notes
    }

    /// 定义项里那些「提交成功、但什么都不做」的组合。
    ///
    /// 管理 API 对它们一律返回 204：策略建好了、`GET /api/policies` 也看得到，
    /// 于是界面上一切正常。真正的效果要等下一次排查时才被发现不存在。
    fn definition_caveats(&self) -> Vec<String> {
        let mut notes = Vec::new();
        let has = |key: &str| self.definition.iter().any(|entry| entry.key.trim() == key);

        // `alternate-exchange` 只对交换机有意义：写进 `apply-to: queues` 是无操作。
        if self.apply_to == PolicyApplyTo::Queues && has("alternate-exchange") {
            notes.push(
                "`alternate-exchange` 只对交换机生效，作用范围选「队列」时它不起作用".to_owned(),
            );
        }
        if self.apply_to == PolicyApplyTo::Exchanges && (has("ha-mode") || has("ha-params")) {
            notes.push(
                "`ha-mode` / `ha-params` 是队列级参数，作用范围选「交换机」时不产生效果".to_owned(),
            );
        }
        notes
    }
}

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

/// 删掉一条策略时，界面必须说清「失去什么」。
///
/// 策略是唯一的声明来源：删掉之后资源不会自动回到「安全默认值」，
/// 而是退回**类型默认**（经典队列没有 TTL、没有长度上限，消息会一直堆到磁盘告急）。
/// 最容易被当成「删了就等于恢复原样」的那几项，单独列出来。
pub fn removal_caveats(definition: &[DefinitionEntry]) -> Vec<String> {
    let has = |key: &str| definition.iter().any(|entry| entry.key.trim() == key);
    let mut notes = Vec::new();

    let mut lost = Vec::new();
    if has("x-message-ttl") || has("message-ttl") {
        lost.push("消息过期时间");
    }
    if has("x-max-length")
        || has("max-length")
        || has("x-max-length-bytes")
        || has("max-length-bytes")
    {
        lost.push("队列长度上限");
    }
    if has("alternate-exchange") {
        lost.push("备选交换机（无法路由的消息会重新变成静默丢弃）");
    }
    if has("ha-mode") || has("ha-params") {
        lost.push("镜像配置（经典镜像队列会退回单节点）");
    }
    if has("max-priority") || has("x-max-priority") {
        // 优先级上限是声明期参数：删掉策略不会把已有队列的优先级「取消」，
        // 只有重新声明的队列才会失去它 —— 说清楚了才不会有人以为改完立刻生效。
        lost.push("优先级上限（仅对之后重新声明的队列生效）");
    }
    if !lost.is_empty() {
        notes.push(format!("删除后这些设置会退回默认：{}", lost.join("、")));
    }
    notes.push("策略删除不影响已经存在的消息，只改变之后的行为".to_owned());
    notes
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

/// 正则模式的「骨架」：去掉锚点与捕获分组，只留下要匹配的内容。
///
/// RabbitMQ 的策略 pattern 是正则，但这里不编译它（本地与 Java 的正则方言
/// 不完全一致，本地错杀比放过更糟）。去掉的只是那几类「不参与匹配字符」的写法。
///
/// 注意这里**不碰** `.*` 与字符类：它们是通配，硬删会把 `orders.*` 变成
/// 「名字里含 orders」；硬留又会把 `orders.*` 当成「名字里含 `orders.`」。
/// 两者的处理都在 `trailing_literal` 里按位置做，而不是在这一层抹平。
fn pattern_core(pattern: &str) -> String {
    pattern
        .trim()
        .replace(['(', ')'], "")
        .replace("$(?)", "")
        .trim_matches(['^', '$'])
        .trim()
        .to_owned()
}

/// 影响面拿不准的原因。
///
/// 三种情况都会让「约 N 个」不可信，而它们在界面上长得完全一样（都是一个数字），
/// 所以必须单独说出来：说「约 1 个」和说「我不知道」，对看确认框的人是两件事。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImpactConfidence {
    /// 只有字面量（含 `.*`），估算可靠。
    Literal,
    /// 模式里有字符类、转义序列、量词或分组，估算可能偏大也会偏小。
    Complex,
    /// 完全没有可比字面量（如 `\d+`、`[a-z]{3}`），返回的数量是按「全量」给的上界。
    Unreadable,
}

impl ImpactConfidence {
    pub const fn is_reliable(self) -> bool {
        matches!(self, Self::Literal)
    }

    /// 给用户的一句话。`None` 表示无需额外提示。
    pub const fn note(self) -> Option<&'static str> {
        match self {
            Self::Literal => None,
            Self::Complex => Some(
                "模式里有字符类或转义（`[]`、`\\d` 之类），本地估算可能偏大也可能偏小，命中范围以服务端为准",
            ),
            Self::Unreadable => {
                Some("模式里没有可比的字面量，下面给的是「最多命中多少」，实际可能一个都不命中")
            }
        }
    }
}

/// 按模式粗略估算这条策略会命中多少资源，用于确认框里的「影响面」。
///
/// 这里不编译正则：目标是给一个数量级，不是精确结果。真正的命中判定在服务端，
/// 面板估错了反而更糟，所以结果带 `exact: false` 与 `confidence`，
/// 界面上写「约」，并在拿不准时说明为什么拿不准。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactEstimate {
    pub queues: usize,
    pub exchanges: usize,
    pub exact: bool,
    /// 估算的可靠程度。非 `Literal` 时界面必须显示 `confidence` 的说明。
    pub confidence: ImpactConfidence,
}

/// 模式里的一段比对依据。`|` 的每个分支各得一份。
struct Segment {
    literal: String,
    /// 分支以 `^` 开头：只命中以字面量开头的名字。
    anchored_start: bool,
    /// 分支以 `$` 结尾且字面量是最后一段：只命中以字面量结尾的名字。
    anchored_end: bool,
    /// 分支是否以 `.` / `.*` 收尾。收尾的是通配，字面量就不能当后缀用：
    /// `orders.*` 里 `orders` 是前缀，只有当它是「分支末尾」时反过来才是错的。
    trailing_wildcard: bool,
}

/// 按 `|` 切成若干分支。`\|` 是转义的竖线，属于字面量，不切。
fn split_alternatives(pattern: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut escaped = false;
    for (index, ch) in pattern.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '|' => {
                parts.push(&pattern[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&pattern[start..]);
    parts
}

/// 分支里最后一个「必须连续出现」的字面量。
///
/// 只有全部由可读字符与通配组成时才认：碰到 `[]`、`\d`、`{2,3}` 这类结构
/// 就返回 `None` —— 那时任何子串判断都只是猜，宁可整条分支不给字面量。
/// 返回（字面量, 是否以通配收尾）。`None` 表示这条分支读不出来。
fn trailing_literal(core: &str) -> Option<(String, bool)> {
    let mut literal = String::new();
    let mut trailing_wildcard = false;
    let mut chars = core.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            // `.` 后面跟 `*` 是「任意字符重复」；其它 `.` 是「任意一个字符」，
            // 两者都会打断「连续字面量」，但已经攒下的字面量仍然有效 ——
            // `orders.*` 的 `orders` 是前缀，`s.*xs` 的 `xs` 是后缀。
            '.' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                }
                // `.` / `.*` 是单个（或任意多个）任意字符，不打断前面攒下的
                // 「必须连续」的字面量：`orders.*` 的 `orders` 照样是前缀。
                trailing_wildcard = true;
            }
            '*' | '+' | '?' | '^' | '$' => {
                // `*` 让前一个字面量重复任意次，含义已不可比（`orders*` 不是
                // 「含 orders」），所以清空；但 `?` 只是可缺省，`orders?` 仍以
                // orders 开头，保留字面量只影响精度，不影响方向。
                if ch == '*' {
                    literal.clear();
                }
                trailing_wildcard = true;
            }
            // 字符类、转义序列、区间量词：整条分支放弃。
            '[' | ']' | '{' | '}' => return None,
            // 反斜杠开头的转义序列（`\\d`、`\\.`）读不出可比字面量，整条分支放弃。
            '\\' => return None,
            other => {
                literal.push(other);
                trailing_wildcard = false;
            }
        }
    }
    if literal.is_empty() {
        return None;
    }
    Some((literal, trailing_wildcard))
}

/// 一条分支的命中方式。锚点来自骨架：`^` / `$` 在 `pattern_core` 里已被剥掉，
/// 所以这里看的是原始分支的两端。
fn segment_matches(segment: &Segment, name: &str) -> bool {
    // 锚点按「分支自己」算，不按整条模式算：`^a|b` 的 `b` 不受 `^` 约束，
    // 拿整条模式的首尾去判会让每个分支都被锚住，结果整体偏大。
    if segment.anchored_start && segment.anchored_end {
        return name == segment.literal;
    }
    if segment.anchored_start {
        return name.starts_with(&segment.literal);
    }
    if segment.anchored_end {
        return name.ends_with(&segment.literal);
    }
    // 分支以 `.` / `.*` 收尾：字面量后面还允许有别的内容，
    // `orders.*` 是「以 orders. 开头」，不是「名字里含 orders」。
    if segment.trailing_wildcard {
        // `.` / `.*` 都要有后续内容才算：`orders.*` 匹配 `orders.` 之后还有东西的
        // 名字，光秃秃的 `orders` 在正则里也不命中 `orders.*`。
        return name.len() > segment.literal.len()
            && name.starts_with(segment.literal.as_str())
            && name.as_bytes()[segment.literal.len()] == b'.';
    }
    name.contains(segment.literal.as_str())
}

/// 估算影响面。`pattern` 为空 / `.*` 时直接返回全量。
pub fn estimate_impact(
    pattern: &str,
    apply_to: PolicyApplyTo,
    queue_names: &[String],
    exchange_names: &[String],
) -> ImpactEstimate {
    let pattern = effective_pattern(pattern);
    let core = pattern_core(pattern);

    // 只有 `.` 与 `*` 就是「任意字符重复若干次」，即全量。这种模式是可读的：
    // 结论本身就是「全部」，不需要再解释。
    // 空 core 也算「全部」：`pattern_core` 把 `^$` 这类剥成空串，
    // 而空模式在 RabbitMQ 里就是匹配一切。
    let blanket = core.chars().all(|ch| matches!(ch, '*' | '.'));

    // 锚点必须从「切分前」的分支上读：`pattern_core` 会剥掉首尾的 `^` / `$`。
    let source_parts = split_alternatives(pattern);
    let core_parts = split_alternatives(&core);

    let mut confidence = ImpactConfidence::Literal;
    let mut segments: Vec<Segment> = Vec::new();
    for (index, part) in core_parts.iter().enumerate() {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let source = source_parts[index].trim();
        match trailing_literal(part) {
            Some((literal, trailing_wildcard)) => segments.push(Segment {
                literal,
                anchored_start: source.starts_with('^'),
                // `orders$` 的 `$` 紧贴字面量，是「必须以它结尾」；
                // `orders.*` 的尾巴是通配，`$` 只在 `.*` 之后才算锚住末尾。
                anchored_end: source.ends_with('$') && !trailing_wildcard,
                trailing_wildcard,
            }),
            // 全量模式（`.*` / `^.*$`）没有字面量是正常的：它的结论就是「全部」，
            // 不需要再解释。其余读不出来的分支才降级：`\d+` 若按字面量 `d` 去比，
            // 会把名字里带 d 的队列全算进去，比不报更误导。
            None => {
                if !blanket {
                    confidence = ImpactConfidence::Unreadable;
                }
            }
        }
    }

    // 分支里的 `[]` / `\` / `{}` 会走到上一条，剩下的「结构字符」在这里兜底：
    // 它们不影响字面量提取（`.` 与 `*` 已在 `trailing_literal` 里处理），
    // 但说明这个模式比「字面量 + 通配」更复杂，估算要标注。
    if confidence == ImpactConfidence::Literal
        && core
            .chars()
            .any(|ch| matches!(ch, '[' | ']' | '\\' | '{' | '}' | '+' | '?'))
    {
        confidence = ImpactConfidence::Complex;
    }

    let hit = |name: &str| {
        if blanket {
            return true;
        }
        if segments.is_empty() {
            // 读不出任何字面量：宁可算作命中，让人去核对（此时 `Unreadable`
            // 已经在界面上说明「这是上界」），也不要显示「一个都不影响」。
            return true;
        }
        segments
            .iter()
            .any(|segment| segment_matches(segment, name))
    };

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
        confidence,
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
        // `.*` 与 `^.*$` 也是「全部」：这几种写法在 RabbitMQ 里完全等价。
        // `^(.*)$` 这里不列：捕获分组里套着 `.*`，本地的粗判认不出「任意」，
        // 会退化成子串匹配。影响面报小了会被 `exact: false` 与界面上的「约」兜住，
        // 而为了它去猜正则只会让别的模式跟着错。
        for pattern in [".*", "^.*$"] {
            let all = estimate_impact(pattern, PolicyApplyTo::All, &queues, &exchanges);
            assert_eq!(all.queues, 3, "{pattern}");
            assert_eq!(all.exchanges, 1, "{pattern}");
        }
    }

    #[test]
    fn wildcard_patterns_are_not_read_as_literals() {
        // 回归：以前把模式里的 `^ $ . *` 一律删掉再当作子串去比，
        // 于是 `^orders` / `orders.*` / `orders$` 都退化成「名字里含 orders」——
        // 影响面算出来是 3，而真正会套上 TTL 的只有以 orders 开头的那 2 个。
        let queues = vec![
            "orders.new".to_owned(),
            "orders.old".to_owned(),
            "audit.orders".to_owned(),
        ];

        let prefix = estimate_impact("^orders", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(prefix.queues, 2, "`^orders` 只命中以 orders 开头的");

        let suffix = estimate_impact("orders$", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(suffix.queues, 1, "`orders$` 只命中以 orders 结尾的");

        let loose = estimate_impact("orders", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(loose.queues, 3, "没有锚点就是子串匹配");

        // `.*` 是「从 orders. 开始」：`orders.new` / `orders.old` 命中，
        // `audit.orders` 不命中。以前把 `.*` 一律删掉，`audit.orders` 也被算进来了。
        let star = estimate_impact("orders.*", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(star.queues, 2, "`orders.*` 只命中以 orders. 开头的");

        // 分支：任一条命中就算命中，锚点只约束它所在的那一条。
        let branch = estimate_impact("^orders|audit", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(branch.queues, 3);
    }

    #[test]
    fn character_classes_and_escapes_are_marked_unreliable() {
        // 回归：以前把模式里的 `^ $ . *` 一律删掉再当子串去比，
        // `[a-z]+\\.orders` 会被删成 `.orders`，于是「名字里含 .orders」——
        // 一个数量级都算不出来的结论被写成「约 N 个」。
        let queues = vec![
            "orders.new".to_owned(),
            "orders.old".to_owned(),
            "audit.orders".to_owned(),
        ];

        let class = estimate_impact("[a-z]+\\\\.orders", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(class.confidence, ImpactConfidence::Unreadable);
        assert!(!class.confidence.is_reliable());
        assert!(class.confidence.note().is_some(), "读不准时必须说明");
        // 读不准时给「上界」而不是 0：0 会被读成「一个都不影响」。
        assert_eq!(class.queues, queues.len());

        // 转义点号同样读不出来。
        let escaped = estimate_impact("orders\\\\.new", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(escaped.confidence, ImpactConfidence::Unreadable);
    }

    #[test]
    fn trailing_dot_star_means_prefix_not_contains() {
        // 回归：`orders.*` 以前把 `.*` 删掉剩下 `orders`，按子串比把
        // `audit.orders` 也算进来。正则里它是「以 orders. 开头」。
        let queues = vec![
            "orders.new".to_owned(),
            "audit.orders".to_owned(),
            "orders".to_owned(),
        ];
        let star = estimate_impact("orders.*", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(star.queues, 1, "只有 orders.new 以 orders. 开头");
        assert_eq!(star.confidence, ImpactConfidence::Literal);
    }

    #[test]
    fn reliable_estimate_needs_no_note() {
        let queues = vec!["orders.new".to_owned()];
        let plain = estimate_impact("^orders", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(plain.confidence, ImpactConfidence::Literal);
        assert!(plain.confidence.note().is_none(), "字面量模式不该多嘴");
        assert!(plain.confidence.is_reliable());

        // 全量模式同样是可靠结论：它就是「全部」。
        let blanket = estimate_impact(".*", PolicyApplyTo::Queues, &queues, &[]);
        assert_eq!(blanket.confidence, ImpactConfidence::Literal);
    }

    #[test]
    fn exchange_only_keys_are_called_out_when_scope_ignores_them() {
        // 这些组合服务端一律 204，界面上看不出任何异常 —— 只能在确认框里说，
        // 否则「策略建好了但什么都不做」要到下次排查才发现。
        let spec = |apply_to: PolicyApplyTo, key: &str| PolicySpec {
            name: "p".to_owned(),
            pattern: "^orders".to_owned(),
            priority: 1,
            apply_to,
            definition: vec![DefinitionEntry {
                key: key.to_owned(),
                value: "x".to_owned(),
            }],
        };

        let wrong_scope = spec(PolicyApplyTo::Queues, "alternate-exchange");
        assert!(
            wrong_scope
                .caveats()
                .iter()
                .any(|note| note.contains("alternate-exchange")),
            "作用范围选队列时 alternate-exchange 不起作用，必须说出来"
        );

        let ha_on_exchange = spec(PolicyApplyTo::Exchanges, "ha-mode");
        assert!(
            ha_on_exchange
                .caveats()
                .iter()
                .any(|note| note.contains("ha-mode")),
            "作用范围选交换机时镜像参数不产生效果，必须说出来"
        );

        // 键与范围对得上时不该多加一句：狼来了喊多了，真出事那句也没人看。
        let right_scope = spec(PolicyApplyTo::Queues, "x-message-ttl");
        assert!(
            !right_scope
                .caveats()
                .iter()
                .any(|note| note.contains("不产生效果") || note.contains("不起作用"))
        );
    }

    #[test]
    fn removal_caveats_name_what_goes_back_to_default() {
        let definition = vec![
            DefinitionEntry {
                key: "x-message-ttl".to_owned(),
                value: "60000".to_owned(),
            },
            DefinitionEntry {
                key: "x-max-length".to_owned(),
                value: "1000".to_owned(),
            },
            DefinitionEntry {
                key: "alternate-exchange".to_owned(),
                value: "ae".to_owned(),
            },
        ];
        let notes = removal_caveats(&definition);
        assert!(notes.iter().any(|note| note.contains("消息过期时间")));
        assert!(notes.iter().any(|note| note.contains("队列长度上限")));
        assert!(notes.iter().any(|note| note.contains("备选交换机")));
        // 「删除不影响已有消息」是这段话的另一半：不说清楚，人会以为会丢消息。
        assert!(
            notes
                .iter()
                .any(|note| note.contains("不影响已经存在的消息"))
        );

        // 空定义也要有基线说明，而不是返回空列表。
        assert!(!removal_caveats(&[]).is_empty());
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
