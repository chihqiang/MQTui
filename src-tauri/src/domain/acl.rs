//! Kafka ACL：谁能对哪个资源做哪种操作 —— 多租户集群里最该先看清的一屏。
//!
//! ## 为什么这一屏只有「看」
//!
//! librdkafka 2.12 **确实**导出了 `DescribeAcls` / `CreateAcls` / `DeleteAcls`，
//! `rdkafka` crate 只包了 topic 与 group 那两组 API，所以这里是按头文件直接调 FFI。
//! 读是安全的：一次请求、一个事件、无状态、失败时什么都不留下。
//!
//! 写（`CreateAcls` / `DeleteAcls`）没做，理由不是「做不了」，而是 ACL 的写入
//! 一旦写错就是**授权事故**：多写一条 = 谁能进来，少写一条 = 谁掉线。
//! 面板要做写入，得先有「与现有规则比对、说明新增/覆盖/冲突」的那一步，
//! 那是另一轮的事。这一轮先回答最要紧的那句：**现在到底允许了什么。**
//!
//! ## 判读规则全在纯函数里
//!
//! 空字段表示什么（`name = ""` 是「全部主题」还是「一个叫空串的主题」？）、
//! 这条规则会不会连自己也拦死、主体里的前缀，都是没有 I/O 的判断，
//! 所以放在这里可以脱离 broker 直接单测。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// 配置了 ACL 后仍然必须放行的操作。
///
/// 这是 Kafka 的硬规则（`StandardAuthorizer` 对 `super.users` 生效，但也意味着
/// 一条 `ALLOW / Cluster / DESCRIBE` 都没有时，连自己那几条 ACL 都读不出来）——
/// 界面上把这三条缺的列出来，比让人自己去对照文档快得多。
pub const BASELINE_OPERATIONS: [AclOperation; 3] = [
    AclOperation::Describe,
    AclOperation::DescribeConfigs,
    AclOperation::AlterConfigs,
];

/// ACL 资源类型。只列面板真的会遇到的四种；`transactional_id` 不在里面
/// （librdkafka 的枚举里有，但 Kafka 的 `ResourceType` 到 5 就停了）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AclResourceType {
    Topic,
    Group,
    Cluster,
    Broker,
}

impl AclResourceType {
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Topic => "主题",
            Self::Group => "消费组",
            Self::Cluster => "集群",
            Self::Broker => "Broker",
        }
    }
}

/// 规则里的操作。`All` 会覆盖其余全部操作，所以它不能与别的操作叠加理解。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AclOperation {
    All,
    Read,
    Write,
    Create,
    Delete,
    Alter,
    Describe,
    DescribeConfigs,
    AlterConfigs,
    ClusterAction,
    IdempotentWrite,
}

impl AclOperation {
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::All => "全部",
            Self::Read => "读",
            Self::Write => "写",
            Self::Create => "建",
            Self::Delete => "删",
            Self::Alter => "改",
            Self::Describe => "查",
            Self::DescribeConfigs => "读配置",
            Self::AlterConfigs => "改配置",
            Self::ClusterAction => "集群动作",
            Self::IdempotentWrite => "幂等写",
        }
    }
}

/// 允许还是拒绝。
///
/// Kafka 里 `DENY` 优先：同一个主体对同一个资源既有 `ALLOW` 又有 `DENY` 时，
/// 以 `DENY` 为准。界面必须把这个优先级说出来，否则两行规则看起来只是重复。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AclPermission {
    Allow,
    Deny,
}

impl AclPermission {
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Allow => "允许",
            Self::Deny => "拒绝",
        }
    }
}

/// 名字怎么匹配。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AclPattern {
    /// 字面量：名字完全相等。
    Literal,
    /// 前缀：`payments-` 覆盖 `payments-orders`。
    Prefixed,
    /// 通配：`*`，即「不分名字」。Kafka 存的是 `Literal` + 名字 `*`，这里拆开表示。
    Wildcard,
}

impl AclPattern {
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Literal => "精确匹配",
            Self::Prefixed => "前缀匹配",
            Self::Wildcard => "全部资源",
        }
    }
}

/// 一条 ACL 规则。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclEntry {
    pub resource_type: AclResourceType,
    /// 资源名；`Wildcard` 模式下为空串（真实名字是 `*`，已经由模式表达）。
    pub resource_name: String,
    pub pattern: AclPattern,
    /// 主体，形如 `User:alice`。
    pub principal: String,
    /// 来源主机，`*` 表示不限。
    pub host: String,
    pub operation: AclOperation,
    pub permission: AclPermission,
}

impl AclEntry {
    /// 资源在界面上的写法：`主题 payments-`（前缀）而不是只给个名字。
    pub fn resource_label(&self) -> String {
        let kind = self.resource_type.display_name();
        match self.pattern {
            AclPattern::Wildcard => kind.to_owned(),
            AclPattern::Prefixed => format!("{kind} {}", self.resource_name),
            AclPattern::Literal => {
                // 集群级资源的名字本来就是 `kafka-cluster`，读出来没有意义。
                if self.resource_type == AclResourceType::Cluster {
                    kind.to_owned()
                } else {
                    format!("{kind} {}", self.resource_name)
                }
            }
        }
    }

    /// 主体去掉 `User:` 前缀后的名字；非 `User:` 主体原样返回。
    ///
    /// 面板按「谁」分组，`User:alice` 与 `User:bob` 要能排在一起，
    /// 而 `Group:...` 这类少见主体不能被误当成用户。
    pub fn principal_name(&self) -> &str {
        self.principal
            .split_once(':')
            .map(|(_, name)| name)
            .unwrap_or(&self.principal)
    }

    /// 这条规则能不能连「读规则的人」自己也管住。
    ///
    /// `Cluster` 资源上的拒绝会命中所有请求，包括读 ACL 这一条 ——
    /// 这是自锁 ACL 的经典做法，界面上要单独提醒，否则改错的下一步
    /// 是「面板突然读不到任何东西」，看起来像 bug。
    pub fn blocks_introspection(&self) -> bool {
        self.permission == AclPermission::Deny
            && self.resource_type == AclResourceType::Cluster
            && matches!(
                self.operation,
                AclOperation::All | AclOperation::Describe | AclOperation::DescribeConfigs
            )
            && (self.host == "*" || self.host == "0.0.0.0")
    }
}

/// 一份 ACL 快照。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclSnapshot {
    pub entries: Vec<AclEntry>,
    /// broker 低于 2.0 或不支持 ACL 时给出原因，而不是一张空表。
    ///
    /// 空表读起来是「集群没有任何 ACL，任何人都能做任何事」——那是个很吓人的结论，
    /// 而真实情况可能只是「这台 broker 压根没开 ACL」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<String>,
    /// 需要用户知道的事实。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl AclSnapshot {
    /// 只读提示：这台集群上到底有没有「不允许任何人做什么」的规则。
    pub fn deny_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|entry| entry.permission == AclPermission::Deny)
            .count()
    }

    /// 可能把自己锁在外面的规则。界面上要排在表格前面提示。
    pub fn self_lock_risks(&self) -> Vec<&AclEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.blocks_introspection())
            .collect()
    }

    /// 按主体分组：一个人有哪些权限。这是排查「他为什么连不上」的起点。
    ///
    /// 排序固定（主体名字典序，其余按资源类型/名字/操作），
    /// 顺序稳定的表才会被人记住。
    pub fn by_principal(&self) -> Vec<PrincipalAcl> {
        let mut groups: Vec<PrincipalAcl> = Vec::new();
        for entry in &self.entries {
            match groups
                .iter_mut()
                .find(|group| group.principal == entry.principal)
            {
                Some(group) => group.entries.push(entry.clone()),
                None => groups.push(PrincipalAcl {
                    principal: entry.principal.clone(),
                    entries: vec![entry.clone()],
                }),
            }
        }
        for group in &mut groups {
            group.entries.sort_by(|left, right| {
                left.resource_type
                    .cmp(&right.resource_type)
                    .then_with(|| left.resource_name.cmp(&right.resource_name))
                    .then_with(|| left.operation.cmp(&right.operation))
            });
            group.entries.dedup();
        }
        groups.sort_by(|left, right| left.principal.cmp(&right.principal));
        groups
    }

    /// 一句话结论。
    pub fn verdict(&self) -> String {
        if let Some(reason) = &self.unsupported {
            return format!("读不到 ACL：{reason}");
        }
        if self.entries.is_empty() {
            return "没有任何 ACL：集群要么没开授权，要么允许所有人做任何事".to_owned();
        }
        let principals = self.by_principal().len();
        format!(
            "{} 条规则，涉及 {principals} 个主体，其中 {} 条是拒绝",
            self.entries.len(),
            self.deny_count()
        )
    }
}

/// 一个主体的全部规则。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalAcl {
    pub principal: String,
    pub entries: Vec<AclEntry>,
}

/// ACL 过滤器：空字段 = 不过滤这一项。
///
/// `None` 与 `Some("")` 必须区分开：`Some("")` 是「名字为空串的资源」
/// （Kafka 用它表示通配），不是「不过滤」。混起来会让用户在搜索框里
/// 敲个空串就把过滤器清掉，自己还不知道。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AclFilter {
    pub resource_type: Option<AclResourceType>,
    pub resource_name: Option<String>,
    pub principal: Option<String>,
    pub operation: Option<AclOperation>,
    pub permission: Option<AclPermission>,
}

impl AclFilter {
    /// 是否什么都不筛。
    pub fn is_empty(&self) -> bool {
        self.resource_type.is_none()
            && self.resource_name.is_none()
            && self.principal.is_none()
            && self.operation.is_none()
            && self.permission.is_none()
    }

    /// 过滤器的中文描述，写在表格上方：「正在看：主题 payments- 的读写」。
    ///
    /// 过滤后的表最容易被误读成全量 —— 所以只要筛了，就必须把它说出来。
    pub fn describe(&self) -> String {
        if self.is_empty() {
            return "全部规则".to_owned();
        }
        let mut parts: Vec<String> = Vec::new();
        if let Some(kind) = self.resource_type {
            parts.push(kind.display_name().to_owned());
        }
        if let Some(name) = self.resource_name.as_ref().filter(|name| !name.is_empty()) {
            parts.push(format!("名字含 {name}"));
        }
        if let Some(principal) = self
            .principal
            .as_ref()
            .filter(|principal| !principal.is_empty())
        {
            parts.push(format!("主体含 {principal}"));
        }
        if let Some(operation) = self.operation {
            parts.push(operation.display_name().to_owned());
        }
        if let Some(permission) = self.permission {
            parts.push(permission.display_name().to_owned());
        }
        format!("筛选：{}", parts.join(" · "))
    }

    /// 本地筛一遍。服务端的过滤是精确匹配，用户想搜「中间那段」时只能本地筛。
    pub fn matches(&self, entry: &AclEntry) -> bool {
        let contains = |value: &str, needle: &Option<String>| match needle {
            Some(needle) if !needle.is_empty() => {
                value.to_lowercase().contains(&needle.to_lowercase())
            }
            _ => true,
        };
        self.resource_type
            .is_none_or(|kind| kind == entry.resource_type)
            && contains(&entry.resource_name, &self.resource_name)
            && contains(&entry.principal, &self.principal)
            && self
                .operation
                .is_none_or(|operation| operation == entry.operation)
            && self
                .permission
                .is_none_or(|permission| permission == entry.permission)
    }
}

/// 组装一份快照：去重、排序、补上必须说清的话。
pub fn assemble_acls(mut entries: Vec<AclEntry>, unsupported: Option<String>) -> AclSnapshot {
    // 同一条规则被服务端回两遍时，界面上会出现两行一模一样的行，用户会以为是两条。
    entries.sort_by(|left, right| {
        left.principal
            .cmp(&right.principal)
            .then_with(|| left.resource_type.cmp(&right.resource_type))
            .then_with(|| left.resource_name.cmp(&right.resource_name))
            .then_with(|| left.operation.cmp(&right.operation))
            .then_with(|| left.permission.cmp(&right.permission))
            .then_with(|| left.host.cmp(&right.host))
    });
    entries.dedup();

    let mut notes = Vec::new();
    if unsupported.is_none() {
        notes.push(
            "面板只读：新建或删除 ACL 请用 kafka-acls.sh —— 写错一条 ACL 是授权事故，不是配置调整"
                .to_owned(),
        );
        if entries
            .iter()
            .any(|entry| entry.permission == AclPermission::Deny)
        {
            notes.push(
                "同一个主体对同一个资源同时有「允许」和「拒绝」时，以「拒绝」为准".to_owned(),
            );
        }
        let hosts: BTreeSet<&str> = entries.iter().map(|entry| entry.host.as_str()).collect();
        if hosts.len() > 1 || !hosts.iter().all(|host| *host == "*") {
            notes.push(
                "规则按「来源主机」分开生效：`*` 覆盖所有机器，限定 IP 的规则只对那个地址生效"
                    .to_owned(),
            );
        }
    }

    AclSnapshot {
        entries,
        unsupported,
        notes,
    }
}

/// 一条规则在「提交前」的比对结论。
///
/// 面板做写入的真正难点不是发请求，而是**在发之前说清这条规则会造成什么**。
/// 四种结论各不相同，只有第一种是纯粹的「新增」：
///
/// - `New`：现在就没人这么写过。提交后多一条规则。
/// - `Exists`：一模一样已经在了。再提交一次不会改变任何东西 —— 但它也不是错误，
///   服务端会照常返回成功，所以界面不能报错，只能说明「本来就有」。
/// - `Conflicts`：同一个主体、同一个资源上有方向相反的规则，或者同资源上已经有一条
///   `全部` 的规则把它盖住。这类要让人看见再决定，不能顺手提交。
/// - `Superseded`：同主体的 `全部` 规则已经覆盖了这条操作，新增这一条不会有额外效果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AclChangeVerdict {
    New,
    Exists,
    Conflicts,
    Superseded,
}

impl AclChangeVerdict {
    pub const fn label(self) -> &'static str {
        match self {
            Self::New => "新增",
            Self::Exists => "已存在",
            Self::Conflicts => "冲突",
            Self::Superseded => "被覆盖",
        }
    }

    /// 会不会真的改变集群上的规则集合。
    pub const fn is_effective(self) -> bool {
        matches!(self, Self::New)
    }
}

/// 一条待提交的规则，以及它在现有规则里的处境。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclChange {
    pub entry: AclEntry,
    pub verdict: AclChangeVerdict,
    /// 判定的理由 / 与它相干的既有规则。冲突与覆盖必须指出来，否则用户没法判断。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<String>,
}

impl AclChange {
    /// 一句话说明，写在确认框里那一行规则下面。
    pub fn note(&self) -> String {
        match self.verdict {
            AclChangeVerdict::New => "提交后新增这一条".to_owned(),
            AclChangeVerdict::Exists => {
                "集群上已经有完全相同的规则，提交不会改变任何东西".to_owned()
            }
            AclChangeVerdict::Conflicts => {
                if self.related.is_empty() {
                    "与现有规则冲突：同一个主体对同一个资源已经有方向相反的规则，DENY 优先"
                        .to_owned()
                } else {
                    format!("与现有规则冲突：{}", self.related.join("；"))
                }
            }
            AclChangeVerdict::Superseded => {
                if self.related.is_empty() {
                    "现有规则已经覆盖它，新增不会有额外效果".to_owned()
                } else {
                    format!("现有规则已经覆盖它：{}", self.related.join("；"))
                }
            }
        }
    }
}

/// 一次写入的完整预演。
///
/// 前端把它整块摆在确认框里，用户看的是这一份；提交时**重新算一遍**，
/// 不复用预览 —— 确认框可能开着几十秒，期间别人可能刚改过 ACL。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclChangePlan {
    pub changes: Vec<AclChange>,
    /// 会真正改变集群的条数。
    pub effective: usize,
    /// 提交前必须让人看见的事实（自锁风险等）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blockers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl AclChangePlan {
    /// 一句话结论：新增几条、其中几条其实没变化、有没有拦路的地方。
    pub fn verdict(&self) -> String {
        if self.changes.is_empty() {
            return "没有要提交的规则".to_owned();
        }
        let mut text = format!(
            "{} 条规则，其中 {} 条会真的改变集群",
            self.changes.len(),
            self.effective
        );
        let conflicts = self
            .changes
            .iter()
            .filter(|change| change.verdict == AclChangeVerdict::Conflicts)
            .count();
        if conflicts > 0 {
            text.push_str(&format!("，{conflicts} 条与现有规则冲突"));
        }
        if !self.blockers.is_empty() {
            text.push_str("；存在必须先确认的风险");
        }
        text
    }

    /// 有没有会把人挡在危险一侧的东西。
    pub fn has_blockers(&self) -> bool {
        !self.blockers.is_empty()
    }
}

/// 写入 / 删除的请求。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AclWriteRequest {
    pub entries: Vec<AclEntry>,
    /// 用户在确认框里手打的主体名。
    ///
    /// ACL 写错是授权事故：多一条「谁能进来」，少一条「谁掉线」。手打一遍不是形式，
    /// 它把「我到底在改谁的权限」从扫一眼变成了必须复述。留空则跳过校验（预演用）。
    pub confirm: String,
}

impl AclWriteRequest {
    /// 校验。返回的错误文案可直接展示。
    pub fn validate(&self) -> Result<(), String> {
        if self.entries.is_empty() {
            return Err("没有选中任何规则".to_owned());
        }
        // 主体集合必须唯一：一次提交跨两个主体时，「手打主体名」这一道校验
        // 就只能对着一个名字打勾，另一个主体等于没确认。
        let principals: BTreeSet<&str> = self
            .entries
            .iter()
            .map(|entry| entry.principal.as_str())
            .collect();
        if principals.len() > 1 {
            return Err(
                "一次只能改一个主体的规则：跨主体提交时「手打主体名」这道确认会形同虚设".to_owned(),
            );
        }
        for entry in &self.entries {
            validate_entry(entry)?;
        }
        if !self.confirm.is_empty() {
            let expected = self.entries[0].principal_name();
            if self.confirm.trim() != expected {
                return Err(format!("确认名不一致：请输入 {expected}"));
            }
        }
        Ok(())
    }
}

/// 单条规则的合法性。全部在发出请求之前拦掉 —— 服务端回的 `INVALID_REQUEST`
/// 只会说「参数不合法」，不会说是哪一项。
pub fn validate_entry(entry: &AclEntry) -> Result<(), String> {
    if entry.principal.trim().is_empty() {
        return Err("主体不能为空（形如 User:alice）".to_owned());
    }
    // 没有类型前缀的主体在 Kafka 里是合法的（有些自定义 principal builder 这么用），
    // 但八成是手滑漏了 `User:`，而这会写出一条永远匹配不到任何连接的规则。
    let principal = entry.principal.trim();
    if !principal.contains(':') {
        return Err(format!(
            "主体 {principal} 缺少类型前缀，八成这样写永远匹配不到任何连接（应形如 User:{principal}）"
        ));
    }
    if entry.principal.contains(char::is_whitespace) {
        return Err("主体里不能有空白字符".to_owned());
    }
    if entry.host.trim().is_empty() {
        return Err("来源主机不能为空，不限来源请填 *".to_owned());
    }
    if entry.host.chars().any(char::is_whitespace) {
        return Err("来源主机里不能有空白字符".to_owned());
    }
    match entry.pattern {
        // 通配由模式表达，名字必须为空 —— 名字填了 `*` 再配上 `Wildcard`，
        // 会让「全部资源」和「一个叫 * 的主题」在两层之间反复打架。
        AclPattern::Wildcard => {
            if !entry.resource_name.is_empty() && entry.resource_name != "*" {
                return Err("通配资源不能同时指定名字".to_owned());
            }
        }
        AclPattern::Literal | AclPattern::Prefixed => {
            if entry.resource_name.trim().is_empty() {
                return Err("这个匹配方式必须填资源名；要覆盖全部资源请选通配".to_owned());
            }
        }
    }
    // 集群级资源只有一条合法名字，填别的服务端不认，报错还很难读。
    if entry.resource_type == AclResourceType::Cluster
        && entry.pattern == AclPattern::Literal
        && !entry.resource_name.is_empty()
        && entry.resource_name != "kafka-cluster"
    {
        return Err("集群级资源的名字只能是 kafka-cluster".to_owned());
    }
    Ok(())
}

/// 两条规则是不是「同一件事」：主体 / 资源 / 主机 / 操作 / 权限全都一样。
///
/// 不看 `permission` 之外的差别；`pattern` 参与比较，因为 `payments-` 前缀
/// 与 `payments` 精确是两条不同的规则。
pub fn same_rule(left: &AclEntry, right: &AclEntry) -> bool {
    left.resource_type == right.resource_type
        && left.resource_name == right.resource_name
        && left.pattern == right.pattern
        && left.principal == right.principal
        && left.host == right.host
        && left.operation == right.operation
        && left.permission == right.permission
}

/// 资源范围是否重叠：通配覆盖同类资源的全部名字，前缀覆盖以它开头的名字。
///
/// 这是 `Conflicts` / `Superseded` 判定的基础。写成纯函数是为了能脱库单测 ——
/// 这套判断错了，面板会给出与真实行为相反的结论，比不给结论更糟。
pub fn resource_overlaps(left: &AclEntry, right: &AclEntry) -> bool {
    if left.resource_type != right.resource_type {
        return false;
    }
    // 集群级资源的名字没有区分度，同类型即同资源。
    if left.resource_type == AclResourceType::Cluster {
        return true;
    }
    let covers = |wide: &AclEntry, narrow: &AclEntry| match wide.pattern {
        AclPattern::Wildcard => true,
        AclPattern::Prefixed => {
            narrow.pattern != AclPattern::Wildcard
                && narrow.resource_name.starts_with(&wide.resource_name)
        }
        AclPattern::Literal => {
            narrow.pattern == AclPattern::Literal && narrow.resource_name == wide.resource_name
        }
    };
    covers(left, right) || covers(right, left)
}

/// 操作是否重叠：`All` 覆盖其余全部，其余只有相等才重叠。
pub fn operation_overlaps(left: &AclEntry, right: &AclEntry) -> bool {
    left.operation == AclOperation::All
        || right.operation == AclOperation::All
        || left.operation == right.operation
}

/// 来源主机是否重叠：`*` 覆盖任何主机；两条具体主机只有相等才互相命中。
pub fn host_overlaps(left: &AclEntry, right: &AclEntry) -> bool {
    left.host == "*" || right.host == "*" || left.host == right.host
}

/// 预演一次「新增这些规则」。
///
/// 结论只基于两份清单的比对，不发任何请求。`existing` 是当前集群上的全部规则
/// （用空过滤器读的那一份），不是用户当前正在看的那张筛选后的表 ——
/// 拿筛选结果去比对，「筛了主题之后新增」会把已有的规则报成「新增」。
pub fn plan_create(existing: &[AclEntry], requested: &[AclEntry]) -> AclChangePlan {
    let mut changes: Vec<AclChange> = Vec::new();
    for entry in requested {
        if changes.iter().any(|change| same_rule(&change.entry, entry)) {
            // 一次提交里重复的同一条规则：合并成一条，不报「冲突」。
            continue;
        }
        let same_principal: Vec<&AclEntry> = existing
            .iter()
            .filter(|current| current.principal == entry.principal)
            .collect();

        if same_principal
            .iter()
            .any(|current| same_rule(current, entry))
        {
            changes.push(AclChange {
                entry: entry.clone(),
                verdict: AclChangeVerdict::Exists,
                related: Vec::new(),
            });
            continue;
        }

        let mut related: Vec<String> = Vec::new();
        let mut conflicts = false;
        let mut superseded = false;
        for current in &same_principal {
            if !resource_overlaps(current, entry)
                || !operation_overlaps(current, entry)
                || !host_overlaps(current, entry)
            {
                continue;
            }
            if current.permission != entry.permission {
                conflicts = true;
                related.push(format!(
                    "已有「{}」{} {}（{}/{}）",
                    current.permission.display_name(),
                    current.resource_label(),
                    current.operation.display_name(),
                    current.host,
                    current.pattern.display_name(),
                ));
                continue;
            }
            // 同方向：`全部` 操作盖住具体操作，或更宽的资源范围盖住更窄的。
            let broader =
                current.operation == AclOperation::All && entry.operation != AclOperation::All;
            // 方向只能是「既有 → 本次」：`*` 盖住限定 IP、通配盖住具体名字、`全部` 盖住单项。
            // 反过来（限定 IP 盖 `*`、具体名字盖通配）不成立，那是新增。
            let wider = covers_resource_or_host(current, entry);
            if broader || wider {
                superseded = true;
                related.push(format!(
                    "已有「{}」{} {}（{}/{}）",
                    current.permission.display_name(),
                    current.resource_label(),
                    current.operation.display_name(),
                    current.host,
                    current.pattern.display_name(),
                ));
            }
        }

        let verdict = if conflicts {
            AclChangeVerdict::Conflicts
        } else if superseded {
            AclChangeVerdict::Superseded
        } else {
            AclChangeVerdict::New
        };
        changes.push(AclChange {
            entry: entry.clone(),
            verdict,
            related,
        });
    }

    let effective = changes
        .iter()
        .filter(|change| change.verdict.is_effective())
        .count();

    // 自锁风险放在最前面：这类规则一落地，面板「什么都读不到」看起来像 bug。
    let mut blockers: Vec<String> = Vec::new();
    for change in &changes {
        if change.entry.blocks_introspection() {
            blockers.push(format!(
                "{} 在集群级资源上被拒了 {}：这条规则会命中所有请求，包括「读 ACL」这一条，提交后你可能连自己写的规则都看不到",
                change.entry.principal,
                change.entry.operation.display_name()
            ));
        }
        if change.entry.principal_name() == "*" {
            blockers.push(format!(
                "主体 {} 是「所有用户」：它对本集群上的每一个客户端生效，不只是你以为的那一个",
                change.entry.principal
            ));
        }
        // 授权器一旦开了，没被允许的操作全部被拒。所以「只有 DENY」这类布局是陷阱：
        // 看起来在收紧，实际上会连正常人一起挡掉。
        if change.entry.permission == AclPermission::Deny && effective <= 1 {
            blockers.push(
                "本次提交没有配套的「允许」规则：集群一旦开启授权器，没被允许的操作全部被拒"
                    .to_owned(),
            );
        }
    }
    blockers.dedup();

    let mut notes = Vec::new();
    if changes
        .iter()
        .any(|change| change.verdict == AclChangeVerdict::Exists)
    {
        notes.push("「已存在」的规则提交后不会改变集群，可以取消勾选".to_owned());
    }
    notes.push("同一个主体对同一个资源同时有「允许」和「拒绝」时，以「拒绝」为准".to_owned());

    AclChangePlan {
        changes,
        effective,
        blockers,
        notes,
    }
}

/// `wide` 是否比 `narrow` 更宽：资源范围更宽，或资源相同时来源主机更宽。
///
/// 方向性很重要 —— 反过来问会得出「限定 IP 的规则盖住了 `*`」这种结论，
/// 而真实行为正好相反。
fn covers_resource_or_host(wide: &AclEntry, narrow: &AclEntry) -> bool {
    if wide.resource_type != narrow.resource_type {
        return false;
    }
    if resource_overlaps_covers(wide, narrow) {
        return true;
    }
    // 资源范围一模一样时，`*` 的主机位比限定 IP 宽。
    let host_wider = wide.host == "*" && narrow.host != "*";
    host_wider && same_scope(wide, narrow)
}

/// 同一段资源范围（前缀对前缀看名字是否相同）。
fn same_scope(left: &AclEntry, right: &AclEntry) -> bool {
    left.resource_type == right.resource_type
        && left.resource_name == right.resource_name
        && left.pattern == right.pattern
}

/// `wide` 是否覆盖 `narrow`（严格宽于，不是同一个）。
fn resource_overlaps_covers(wide: &AclEntry, narrow: &AclEntry) -> bool {
    // 这里只比「范围」，不比整条规则：前缀 vs 前缀、通配 vs 具体名字都要能判出来。
    if wide.resource_type != narrow.resource_type {
        return false;
    }
    match wide.pattern {
        AclPattern::Wildcard => {
            narrow.pattern != AclPattern::Wildcard || narrow.resource_name == "*"
        }
        AclPattern::Prefixed => {
            narrow.pattern == AclPattern::Prefixed
                && narrow.resource_name != wide.resource_name
                && narrow.resource_name.starts_with(&wide.resource_name)
        }
        AclPattern::Literal => false,
    }
}

/// 预演一次删除：只有和现有规则逐字相等的条目才算数。
///
/// 删除最容易出的事是「以为删了一条，其实删了一类」：管理 API 收的是过滤器，
/// 一个空名字的过滤器会把同类资源上所有规则一次删光。所以这里坚持**精确匹配**，
/// 并且把不在集群上的条目单独列出来 —— 它们提交时会被跳过，不报成功。
pub fn plan_delete(existing: &[AclEntry], requested: &[AclEntry]) -> AclChangePlan {
    let mut changes: Vec<AclChange> = Vec::new();
    for entry in requested {
        if changes.iter().any(|change| same_rule(&change.entry, entry)) {
            continue;
        }
        let matched: Vec<&AclEntry> = existing
            .iter()
            .filter(|current| same_rule(current, entry))
            .collect();
        if matched.is_empty() {
            // 「集群上没有这条」不是错误，但它也不该显示成「删除成功」。
            changes.push(AclChange {
                entry: entry.clone(),
                verdict: AclChangeVerdict::Exists,
                related: vec!["集群上已经找不到这条规则（可能刚被别人删过）".to_owned()],
            });
            continue;
        }
        changes.push(AclChange {
            entry: entry.clone(),
            verdict: AclChangeVerdict::New,
            related: Vec::new(),
        });
    }

    let effective = changes
        .iter()
        .filter(|change| change.verdict.is_effective())
        .count();
    let mut blockers = Vec::new();
    for change in &changes {
        if change.verdict.is_effective() && change.entry.blocks_introspection() {
            blockers.push(format!(
                "删掉 {} 的集群级「拒绝 {}」反而是在恢复访问 —— 确认你删的是对的那一条",
                change.entry.principal,
                change.entry.operation.display_name()
            ));
        }
    }
    AclChangePlan {
        changes,
        effective,
        blockers,
        notes: vec!["删除按规则逐字匹配，不会顺带删掉同类的其它规则".to_owned()],
    }
}

/// 规则 A 的资源名字是否覆盖规则 B 的。
///
/// 这是「按过滤器语义比」的地基：`DeleteAcls` 收的是过滤器，服务端回的
/// `matching_acls` 是**实际命中并删掉的**那几条 ACL 内容，而不是请求本身。
/// 拿 binding 逐字相等去对，前缀规则（`payments-`）永远对不上自己 ——
/// 服务端从没回过一条「名字是 `payments-` 的 ACL」，它回的是 `payments-orders`。
pub fn resource_covers(wide: &AclEntry, narrow: &AclEntry) -> bool {
    if wide.resource_type != narrow.resource_type {
        return false;
    }
    // 集群级资源的名字没有区分度，同类型即同资源。
    if wide.resource_type == AclResourceType::Cluster {
        return true;
    }
    covers_name(wide, narrow)
}

/// 不看资源类型的版本：回执比对时两边都来自同一批请求，但 `Broker`/`Cluster`
/// 在协议里共用 `BROKER`，名字又都是 `kafka-cluster`，逐字比会漏。
fn covers_name(wide: &AclEntry, narrow: &AclEntry) -> bool {
    match wide.pattern {
        AclPattern::Wildcard => true,
        AclPattern::Prefixed => match narrow.pattern {
            // `payments-*` 这个名字本身以 `payments-` 打头：前缀能匹配到前缀。
            AclPattern::Prefixed => narrow.resource_name.starts_with(&wide.resource_name),
            AclPattern::Literal => narrow.resource_name.starts_with(&wide.resource_name),
            AclPattern::Wildcard => false,
        },
        // 精确匹配只认「存盘名字相同」。通配存盘就是 `Literal` + 名字 `*`，
        // 所以 `*` 能命中通配规则；反过来不行。
        AclPattern::Literal => match narrow.pattern {
            AclPattern::Literal => narrow.resource_name == wide.resource_name,
            AclPattern::Prefixed => false,
            AclPattern::Wildcard => wide.resource_name == "*",
        },
    }
}

/// 主体是否覆盖：`User:*` 命中所有人，其余按字面量比。
fn principal_covers(wide: &str, narrow: &str) -> bool {
    wide == narrow || wide == "User:*"
}

/// 来源主机是否覆盖：`*` 不限来源。
fn host_covers(wide: &str, narrow: &str) -> bool {
    wide == narrow || wide == "*"
}

/// 操作是否覆盖：`All` 一条覆盖其余全部。
fn operation_covers(wide: AclOperation, narrow: AclOperation) -> bool {
    wide == narrow || wide == AclOperation::All
}

/// 这条 ACL 会不会被这门过滤器删掉。
///
/// 判据是「过滤器覆盖了它」，不是「它等于过滤器」：`DeleteAcls` 按覆盖关系命中。
/// 写成纯函数而非直接比 binding，是因为回执里带的是命中结果 —— 两边的形状
/// 本来就不一样，硬比只会得到「每条都回执不一致」。
pub fn filter_matches(wanted: &AclEntry, hit: &AclEntry) -> bool {
    resource_covers(wanted, hit)
        && principal_covers(&wanted.principal, &hit.principal)
        && host_covers(&wanted.host, &hit.host)
        && operation_covers(wanted.operation, hit.operation)
        // 权限位从来没有通配，`ANY` 只存在于请求里，服务端回的一定是具体值。
        && wanted.permission == hit.permission
}

/// 两条规则的界面指纹，用于表格 key 与勾选状态。顺序固定，别改。
pub fn entry_fingerprint(entry: &AclEntry) -> String {
    format!(
        "{}|{}|{}|{:?}|{:?}|{:?}|{:?}",
        entry.principal,
        entry.host,
        entry.resource_name,
        entry.pattern,
        entry.operation,
        entry.permission,
        entry.resource_type
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        resource_type: AclResourceType,
        name: &str,
        pattern: AclPattern,
        principal: &str,
        operation: AclOperation,
        permission: AclPermission,
    ) -> AclEntry {
        AclEntry {
            resource_type,
            resource_name: name.to_owned(),
            pattern,
            principal: principal.to_owned(),
            host: "*".to_owned(),
            operation,
            permission,
        }
    }

    #[test]
    fn filter_matching_is_about_coverage_not_equality() {
        // DeleteAcls 收的是过滤器，回执里带的是**命中的 ACL** —— 两者形状不同，
        // 逐字比会把一次成功的前缀删除报成「回执不一致」。
        let prefixed = entry(
            AclResourceType::Topic,
            "payments-",
            AclPattern::Prefixed,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        let hit = entry(
            AclResourceType::Topic,
            "payments-orders",
            AclPattern::Literal,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        assert!(filter_matches(&prefixed, &hit));
        assert!(filter_matches(&prefixed, &prefixed));
        // 名字不在前缀里、操作不同、权限不同，都不该被这门过滤器认领。
        assert!(!filter_matches(
            &hit,
            &entry(
                AclResourceType::Topic,
                "orders",
                AclPattern::Literal,
                "User:alice",
                AclOperation::Read,
                AclPermission::Allow,
            )
        ));
        assert!(!filter_matches(
            &prefixed,
            &entry(
                AclResourceType::Topic,
                "payments-orders",
                AclPattern::Literal,
                "User:alice",
                AclOperation::Write,
                AclPermission::Allow,
            )
        ));
        assert!(!filter_matches(
            &prefixed,
            &entry(
                AclResourceType::Topic,
                "payments-orders",
                AclPattern::Literal,
                "User:alice",
                AclOperation::Read,
                AclPermission::Deny,
            )
        ));
    }

    #[test]
    fn wildcard_principal_and_host_cover_everything() {
        let orders = entry(
            AclResourceType::Topic,
            "orders",
            AclPattern::Literal,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        let everyone = AclEntry {
            principal: "User:*".to_owned(),
            operation: AclOperation::All,
            ..orders.clone()
        };
        assert!(filter_matches(&everyone, &orders));
        // 方向性：谁都能删的过滤器命中 alice 的规则，反之不成立。
        assert!(!filter_matches(&orders, &everyone));
    }

    #[test]
    fn wildcard_resource_reads_as_whole_kind() {
        let item = entry(
            AclResourceType::Topic,
            "",
            AclPattern::Wildcard,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        // 显示成「主题」而不是「主题 」—— 通配已经由类型表达了。
        assert_eq!(item.resource_label(), "主题");
    }

    #[test]
    fn cluster_name_is_not_repeated() {
        let item = entry(
            AclResourceType::Cluster,
            "kafka-cluster",
            AclPattern::Literal,
            "User:admin",
            AclOperation::All,
            AclPermission::Allow,
        );
        assert_eq!(item.resource_label(), "集群");
    }

    #[test]
    fn prefixed_resource_keeps_its_prefix() {
        let item = entry(
            AclResourceType::Topic,
            "payments-",
            AclPattern::Prefixed,
            "User:pay",
            AclOperation::Write,
            AclPermission::Allow,
        );
        assert_eq!(item.resource_label(), "主题 payments-");
    }

    #[test]
    fn principal_name_strips_only_the_first_colon() {
        let item = entry(
            AclResourceType::Topic,
            "t",
            AclPattern::Literal,
            "User:CN=alice,OU=ops",
            AclOperation::Read,
            AclPermission::Allow,
        );
        assert_eq!(item.principal_name(), "CN=alice,OU=ops");
    }

    #[test]
    fn deny_on_cluster_describe_is_a_self_lock_risk() {
        let item = entry(
            AclResourceType::Cluster,
            "kafka-cluster",
            AclPattern::Literal,
            "User:*",
            AclOperation::Describe,
            AclPermission::Deny,
        );
        assert!(item.blocks_introspection());

        // 只拒「改配置」不会挡住读，别乱报。
        let narrow = entry(
            AclResourceType::Cluster,
            "kafka-cluster",
            AclPattern::Literal,
            "User:*",
            AclOperation::AlterConfigs,
            AclPermission::Deny,
        );
        assert!(!narrow.blocks_introspection());
    }

    #[test]
    fn allow_rules_are_never_self_lock() {
        let item = entry(
            AclResourceType::Cluster,
            "kafka-cluster",
            AclPattern::Literal,
            "User:*",
            AclOperation::All,
            AclPermission::Allow,
        );
        assert!(!item.blocks_introspection());
    }

    #[test]
    fn duplicates_are_removed() {
        let item = entry(
            AclResourceType::Topic,
            "orders",
            AclPattern::Literal,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        let snapshot = assemble_acls(vec![item.clone(), item], None);
        assert_eq!(snapshot.entries.len(), 1);
    }

    #[test]
    fn principals_are_grouped_and_sorted() {
        let snapshot = assemble_acls(
            vec![
                entry(
                    AclResourceType::Topic,
                    "b",
                    AclPattern::Literal,
                    "User:zoe",
                    AclOperation::Read,
                    AclPermission::Allow,
                ),
                entry(
                    AclResourceType::Topic,
                    "a",
                    AclPattern::Literal,
                    "User:alice",
                    AclOperation::Write,
                    AclPermission::Allow,
                ),
                entry(
                    AclResourceType::Group,
                    "g",
                    AclPattern::Literal,
                    "User:alice",
                    AclOperation::Read,
                    AclPermission::Allow,
                ),
            ],
            None,
        );
        let groups = snapshot.by_principal();
        assert_eq!(groups.len(), 2);
        // alice 在前（字典序），且她的主题规则排在组规则之前。
        assert_eq!(groups[0].principal, "User:alice");
        assert_eq!(groups[0].entries.len(), 2);
        assert_eq!(groups[0].entries[0].resource_type, AclResourceType::Topic);
    }

    #[test]
    fn unsupported_snapshot_does_not_claim_open_access() {
        let snapshot = assemble_acls(Vec::new(), Some("broker 没有开启授权".to_owned()));
        assert!(snapshot.entries.is_empty());
        // 空表 + 不支持时，不能说「任何人都能做任何事」—— 那是另一个结论。
        assert!(snapshot.verdict().contains("读不到"));
        assert!(!snapshot.verdict().contains("任何人"));
    }

    #[test]
    fn empty_snapshot_is_explicit_about_open_access() {
        let snapshot = assemble_acls(Vec::new(), None);
        assert!(snapshot.verdict().contains("没有任何 ACL"));
    }

    #[test]
    fn filter_distinguishes_none_from_empty_string() {
        let item = entry(
            AclResourceType::Topic,
            "orders",
            AclPattern::Literal,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        // 空串 = 这一项不筛，规则照常命中。
        let blank = AclFilter {
            resource_name: Some(String::new()),
            ..AclFilter::default()
        };
        assert!(blank.matches(&item));
        // 有值时会过滤掉。
        let narrow = AclFilter {
            resource_name: Some("payments".to_owned()),
            ..AclFilter::default()
        };
        assert!(!narrow.matches(&item));
    }

    #[test]
    fn filter_is_case_insensitive_on_names() {
        let item = entry(
            AclResourceType::Topic,
            "Orders",
            AclPattern::Literal,
            "User:Alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        let filter = AclFilter {
            principal: Some("alice".to_owned()),
            ..AclFilter::default()
        };
        assert!(filter.matches(&item));
    }

    #[test]
    fn filter_description_says_what_is_filtered() {
        let filter = AclFilter {
            resource_type: Some(AclResourceType::Topic),
            permission: Some(AclPermission::Deny),
            ..AclFilter::default()
        };
        assert_eq!(filter.describe(), "筛选：主题 · 拒绝");
    }

    #[test]
    fn deny_rules_note_only_appears_when_a_deny_exists() {
        let allowed = assemble_acls(
            vec![entry(
                AclResourceType::Topic,
                "t",
                AclPattern::Literal,
                "User:a",
                AclOperation::Read,
                AclPermission::Allow,
            )],
            None,
        );
        assert!(!allowed.notes.iter().any(|note| note.contains("拒绝」为准")));

        let denied = assemble_acls(
            vec![entry(
                AclResourceType::Topic,
                "t",
                AclPattern::Literal,
                "User:a",
                AclOperation::Read,
                AclPermission::Deny,
            )],
            None,
        );
        assert!(denied.notes.iter().any(|note| note.contains("拒绝」为准")));
        assert_eq!(denied.deny_count(), 1);
    }

    // ---- 写入预演：结论必须说得比「新增成功」更细 ----

    fn allow(principal: &str, name: &str, operation: AclOperation) -> AclEntry {
        entry(
            AclResourceType::Topic,
            name,
            AclPattern::Literal,
            principal,
            operation,
            AclPermission::Allow,
        )
    }

    #[test]
    fn identical_rule_is_already_there_not_new() {
        let existing = vec![allow("User:alice", "orders", AclOperation::Read)];
        let plan = plan_create(&existing, &existing);
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::Exists);
        // 已存在不是错误，但它也不该被算成「会改变集群」。
        assert_eq!(plan.effective, 0);
        assert!(plan.changes[0].note().contains("不会改变任何东西"));
    }

    #[test]
    fn opposite_permission_is_a_conflict() {
        let existing = vec![AclEntry {
            permission: AclPermission::Deny,
            ..allow("User:alice", "orders", AclOperation::Read)
        }];
        let plan = plan_create(
            &existing,
            &[allow("User:alice", "orders", AclOperation::Read)],
        );
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::Conflicts);
        // 冲突必须指出是哪一条在相干，否则用户没法判断。
        assert!(plan.changes[0].related[0].contains("拒绝"));
        assert!(plan.verdict().contains("冲突"));
    }

    #[test]
    fn allow_all_supersedes_a_specific_operation() {
        let existing = vec![allow("User:alice", "orders", AclOperation::All)];
        let plan = plan_create(
            &existing,
            &[allow("User:alice", "orders", AclOperation::Write)],
        );
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::Superseded);
        assert_eq!(plan.effective, 0);
    }

    #[test]
    fn wildcard_resource_supersedes_a_specific_topic() {
        let existing = vec![entry(
            AclResourceType::Topic,
            "",
            AclPattern::Wildcard,
            "User:ops",
            AclOperation::Read,
            AclPermission::Allow,
        )];
        let plan = plan_create(
            &existing,
            &[allow("User:ops", "orders", AclOperation::Read)],
        );
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::Superseded);
    }

    #[test]
    fn prefix_on_another_name_does_not_overlap() {
        // payments- 与 orders 毫无关系：把不相关的规则报成「被覆盖」会让人白改一轮。
        let existing = vec![entry(
            AclResourceType::Topic,
            "payments-",
            AclPattern::Prefixed,
            "User:ops",
            AclOperation::Read,
            AclPermission::Allow,
        )];
        let plan = plan_create(
            &existing,
            &[allow("User:ops", "orders", AclOperation::Read)],
        );
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::New);
    }

    #[test]
    fn different_principal_is_never_a_conflict() {
        // 别人的规则与这次提交无关；同一个资源上两个人各有一条允许是常态。
        let existing = vec![allow("User:bob", "orders", AclOperation::Read)];
        let plan = plan_create(
            &existing,
            &[allow("User:alice", "orders", AclOperation::Read)],
        );
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::New);
        assert_eq!(plan.effective, 1);
    }

    #[test]
    fn host_scope_matters_when_comparing() {
        // 回归：模型里 `AclEntry.host` 的 `*` 是「不限来源」，比限定 IP 宽。
        // 下面这条 restricted 是既有规则（限一个 IP），提交的是 `*`——更宽，属于新增。
        let mut restricted = allow("User:alice", "orders", AclOperation::Read);
        restricted.host = "10.0.0.1".to_owned();
        let existing = vec![restricted];
        // 反过来：既有规则限定 IP，提交的 `*` 是更宽的那条，不能被报成「已覆盖」。
        let plan = plan_create(
            &existing,
            &[allow("User:alice", "orders", AclOperation::Read)],
        );
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::New);

        // 已有 `*`，再提一条限定 IP 的，是更窄的规则，被 `*` 覆盖。
        let wider = vec![allow("User:alice", "orders", AclOperation::Read)];
        let mut narrow = allow("User:alice", "orders", AclOperation::Read);
        narrow.host = "10.0.0.1".to_owned();
        let plan = plan_create(&wider, &[narrow]);
        assert_eq!(plan.changes[0].verdict, AclChangeVerdict::Superseded);
    }

    #[test]
    fn duplicate_rows_in_one_request_are_merged() {
        let item = allow("User:alice", "orders", AclOperation::Read);
        let plan = plan_create(&[], &[item.clone(), item]);
        assert_eq!(plan.changes.len(), 1);
        assert_eq!(plan.effective, 1);
    }

    #[test]
    fn self_lock_rule_is_a_blocker() {
        let risky = entry(
            AclResourceType::Cluster,
            "kafka-cluster",
            AclPattern::Literal,
            "User:*",
            AclOperation::Describe,
            AclPermission::Deny,
        );
        let plan = plan_create(&[], &[risky]);
        assert!(plan.has_blockers());
        assert!(plan.blockers.iter().any(|text| text.contains("读 ACL")));
        assert!(plan.verdict().contains("必须先确认"));
    }

    #[test]
    fn wildcard_principal_is_called_out() {
        // `User:*` 看起来像「某个用户」，其实是所有人 —— 这是最容易误提交的一条。
        let plan = plan_create(&[], &[allow("User:*", "orders", AclOperation::Read)]);
        assert!(plan.blockers.iter().any(|text| text.contains("所有用户")));
    }

    #[test]
    fn deny_without_any_allow_is_a_blocker() {
        let deny = AclEntry {
            permission: AclPermission::Deny,
            ..allow("User:alice", "orders", AclOperation::Read)
        };
        let plan = plan_create(&[], &[deny]);
        assert!(
            plan.blockers
                .iter()
                .any(|text| text.contains("没有配套的「允许」规则"))
        );
    }

    #[test]
    fn deny_with_a_companion_allow_is_not_blocked() {
        let deny = AclEntry {
            permission: AclPermission::Deny,
            ..allow("User:alice", "orders", AclOperation::Read)
        };
        let plan = plan_create(
            &[],
            &[allow("User:alice", "orders", AclOperation::Read), deny],
        );
        assert!(
            !plan
                .blockers
                .iter()
                .any(|text| text.contains("没有配套的「允许」规则"))
        );
    }

    #[test]
    fn empty_request_is_rejected_before_any_network_call() {
        let request = AclWriteRequest::default();
        assert!(request.validate().is_err());
    }

    #[test]
    fn cross_principal_submission_is_rejected() {
        // 跨主体提交时「手打主体名」只能对上一个，另一个等于没确认。
        let request = AclWriteRequest {
            entries: vec![
                allow("User:alice", "a", AclOperation::Read),
                allow("User:bob", "b", AclOperation::Read),
            ],
            confirm: "alice".to_owned(),
        };
        let error = request.validate().expect_err("应当拒绝");
        assert!(error.contains("一次只能改一个主体"));
    }

    #[test]
    fn confirmation_must_match_the_principal() {
        let mut request = AclWriteRequest {
            entries: vec![allow("User:alice", "orders", AclOperation::Read)],
            confirm: "alice".to_owned(),
        };
        assert!(request.validate().is_ok());
        request.confirm = "bob".to_owned();
        assert!(request.validate().is_err());
    }

    #[test]
    fn principal_without_type_prefix_is_rejected() {
        // 写成 `alice` 的规则能存进去，但永远匹配不到任何连接 —— 静默失败。
        let item = allow("alice", "orders", AclOperation::Read);
        let error = validate_entry(&item).expect_err("应当拒绝");
        assert!(error.contains("User:alice"));
    }

    #[test]
    fn wildcard_resource_must_not_carry_a_name() {
        let mut item = entry(
            AclResourceType::Topic,
            "orders",
            AclPattern::Wildcard,
            "User:alice",
            AclOperation::Read,
            AclPermission::Allow,
        );
        assert!(validate_entry(&item).is_err());
        item.resource_name = String::new();
        assert!(validate_entry(&item).is_ok());
    }

    #[test]
    fn cluster_resource_name_must_be_the_known_one() {
        let mut item = entry(
            AclResourceType::Cluster,
            "prod-cluster",
            AclPattern::Literal,
            "User:alice",
            AclOperation::Describe,
            AclPermission::Allow,
        );
        assert!(validate_entry(&item).is_err());
        item.resource_name = "kafka-cluster".to_owned();
        assert!(validate_entry(&item).is_ok());
    }

    #[test]
    fn empty_host_is_rejected() {
        let mut item = allow("User:alice", "orders", AclOperation::Read);
        item.host = String::new();
        assert!(validate_entry(&item).is_err());
    }

    #[test]
    fn delete_plans_only_exact_matches() {
        let existing = vec![
            allow("User:alice", "orders", AclOperation::Read),
            allow("User:alice", "orders", AclOperation::Write),
        ];
        let plan = plan_delete(
            &existing,
            &[allow("User:alice", "orders", AclOperation::Read)],
        );
        assert_eq!(plan.changes.len(), 1);
        assert!(plan.changes[0].verdict.is_effective());
        assert_eq!(plan.effective, 1);
    }

    #[test]
    fn deleting_something_absent_is_not_reported_as_success() {
        let plan = plan_delete(&[], &[allow("User:alice", "orders", AclOperation::Read)]);
        assert!(!plan.changes[0].verdict.is_effective());
        assert!(plan.changes[0].related[0].contains("找不到"));
        assert_eq!(plan.effective, 0);
    }

    #[test]
    fn fingerprint_separates_rules_that_differ_in_one_field() {
        let base = allow("User:alice", "orders", AclOperation::Read);
        let other = allow("User:alice", "orders", AclOperation::Write);
        assert_ne!(entry_fingerprint(&base), entry_fingerprint(&other));
        assert_eq!(entry_fingerprint(&base), entry_fingerprint(&base.clone()));
    }
}
