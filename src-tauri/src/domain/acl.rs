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
}
