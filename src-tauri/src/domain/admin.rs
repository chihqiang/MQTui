//! RabbitMQ 账户管理：vhost、用户、权限三件事。
//!
//! 为什么单独成一层：这三者共用 `management.rs` 的 HTTP 客户端，但**语义不是
//! 同一类资源的增删改查**，混在一起会顺手写出危险操作：
//!
//! 1. **删 vhost 等于删掉它里面所有队列和消息**。管理 API 没有「只删空 vhost」
//!    的参数，服务端问都不问。所以这条必须由界面先说清后果，而不是点了就发。
//! 2. **`configure` / `write` / `read` 里的 `.*` 是「对这个 vhost 里的一切」**。
//!    手滑多打一个 `.*`，普通账号就变成了管理员。
//! 3. **`tags` 决定能不能登管理界面**。`administrator` / `monitoring` /
//!    `management` / `policymaker`，写错一个字母服务端不会报错，只是那个用户
//!    永远看不到管理页。
//!
//! 规则全收成纯函数，不碰网络，可单测。前端对应 `src/lib/admin.ts`。

use serde::{Deserialize, Serialize};

/// 用户标签。顺序与 RabbitMQ 文档一致，界面直接照这个顺序展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserTag {
    /// 能进管理界面，且能看所有 vhost 的节点、连接、队列。
    Administrator,
    /// 能进管理界面，只看得到指标，改不了东西。
    Monitoring,
    /// 能进管理界面，只看得到自己被授权的 vhost。
    Management,
    /// 能进管理界面，且能改策略与参数。
    Policymaker,
    /// 内置的给 shovel / federation 用的角色，不给登录。
    Impersonator,
    /// 内置的登录用角色。
    None,
}

impl UserTag {
    /// 管理 API 里的原始值。`None` 这一档在 API 里就是空串。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Administrator => "administrator",
            Self::Monitoring => "monitoring",
            Self::Management => "management",
            Self::Policymaker => "policymaker",
            Self::Impersonator => "impersonator",
            Self::None => "",
        }
    }

    /// 未知标签原样保留比丢掉安全：丢掉一个 `policymaker` 会让人无法解释
    /// 「为什么这个账号能改策略」。所以解析入口返回 `Option`，由上层决定怎么降级。
    pub fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Some(Self::None);
        }
        [
            Self::Administrator,
            Self::Monitoring,
            Self::Management,
            Self::Policymaker,
            Self::Impersonator,
        ]
        .into_iter()
        .find(|item| item.as_str() == raw)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Administrator => "管理员",
            Self::Monitoring => "监控",
            Self::Management => "管理",
            Self::Policymaker => "策略",
            Self::Impersonator => "代理",
            Self::None => "无",
        }
    }

    /// 能不能登管理界面（HTTP API / 控制台）。
    ///
    /// 这一点在界面上必须显眼：用户建好了、密码也对，但标签是 `None`，
    /// 结果连管理页都进不去——而服务端不会有任何报错。
    pub const fn can_login(self) -> bool {
        matches!(
            self,
            Self::Administrator | Self::Monitoring | Self::Management | Self::Policymaker
        )
    }
}

/// 一个用户。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub name: String,
    /// 原始标签串。未知标签（插件注册的）原样带出来，不做魔改。
    pub tags: Vec<String>,
}

impl UserInfo {
    /// 解析后的标签，认不出的直接跳过（`tags` 里有原文，界面上仍看得到）。
    pub fn parsed_tags(&self) -> Vec<UserTag> {
        self.tags
            .iter()
            .filter_map(|tag| UserTag::parse(tag))
            .collect()
    }

    /// 这个账号能否登管理界面。空标签也算「不能」。
    pub fn can_login(&self) -> bool {
        self.parsed_tags().iter().any(|tag| tag.can_login())
    }

    /// 是否管理员。界面上要标出来——管理员账号能改别人的密码。
    pub fn is_admin(&self) -> bool {
        self.parsed_tags().contains(&UserTag::Administrator)
    }
}

/// 一个用户在某个 vhost 上的权限。
///
/// 三段正则互相独立：`configure` 管「能不能声明/删除资源」，`write` 管「能不能
/// 发消息」，`read` 管「能不能收消息」。常见的坑是只给了 `write` 与 `read`
/// 却忘了 `configure`，于是队列只能由别人建。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    pub user: String,
    pub vhost: String,
    pub configure: String,
    pub write: String,
    pub read: String,
}

/// 权限里那条「全开」的正则。
pub const FULL_ACCESS: &str = ".*";

impl PermissionInfo {
    /// 三段是否都是全开。这是「给管理员开的口子」，确认框里要说出来。
    pub fn is_full_access(&self) -> bool {
        [&self.configure, &self.write, &self.read]
            .iter()
            .all(|value| value.trim() == FULL_ACCESS)
    }

    /// 三段里空着的那些。空正则等于「什么都不许」，通常不是本意。
    pub fn empty_segments(&self) -> Vec<&'static str> {
        let mut empty = Vec::new();
        if self.configure.trim().is_empty() {
            empty.push("configure");
        }
        if self.write.trim().is_empty() {
            empty.push("write");
        }
        if self.read.trim().is_empty() {
            empty.push("read");
        }
        empty
    }
}

/// 一个 vhost。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VhostInfo {
    pub name: String,
    pub description: String,
    /// 是否给 shovel / federation 用的内部 vhost（`/` 不是）。
    pub tracing: bool,
}

/// 默认 vhost 的名字。
pub const DEFAULT_VHOST: &str = "/";

impl VhostInfo {
    /// 删除它连带的后果。默认 vhost 删不掉，服务端的报错也很含糊，这里提前说。
    pub fn delete_warning(&self) -> Option<String> {
        if self.name == DEFAULT_VHOST {
            return Some("默认 vhost `/` 不能被删除：它是连接串里省略 vhost 时的落点".to_owned());
        }
        Some(format!(
            "删除 vhost `{}` 会连带删掉它里面所有队列、交换机与消息；\
             权限与策略也会一并消失。这个操作不可撤销，管理 API 没有「只删空的」这个选项",
            self.name
        ))
    }
}

/// 删除判定：哪些名字不许动。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemovalBlock {
    /// 名字是空的。
    EmptyName,
    /// 默认 vhost 删不掉。
    DefaultVhost,
    /// 删掉当前连接正在用的账号，等于把自己锁在门外。
    CurrentUser(String),
}

impl RemovalBlock {
    pub fn reason(&self) -> String {
        match self {
            Self::EmptyName => "名称为空".to_owned(),
            Self::DefaultVhost => {
                "默认 vhost `/` 不能删除：连接串里省略 vhost 时落的就是它".to_owned()
            }
            Self::CurrentUser(user) => {
                format!("`{user}` 是当前连接正在使用的账号，删掉它会让这条连接立刻失去权限")
            }
        }
    }
}

/// 判断一个 vhost 能不能删。
pub fn check_vhost_removal(name: &str) -> Result<(), RemovalBlock> {
    let name = name.trim();
    if name.is_empty() {
        return Err(RemovalBlock::EmptyName);
    }
    if name == DEFAULT_VHOST {
        return Err(RemovalBlock::DefaultVhost);
    }
    Ok(())
}

/// 判断一个用户能不能删。`current` 是当前连接用的账号。
pub fn check_user_removal(name: &str, current: &str) -> Result<(), RemovalBlock> {
    let name = name.trim();
    if name.is_empty() {
        return Err(RemovalBlock::EmptyName);
    }
    if name == current.trim() {
        return Err(RemovalBlock::CurrentUser(name.to_owned()));
    }
    Ok(())
}

/// 新建用户的规格。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSpec {
    pub name: String,
    /// 为空表示「不改密码」（编辑场景）；新建时为空会被拦下。
    pub password: String,
    pub tags: Vec<String>,
}

/// 规格校验的阻断项。每一种都对应一句可直接展示的话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecBlock {
    EmptyName,
    EmptyPassword,
    /// 名字里有管理 API 路径需要的转义字符之外还有空格之类，容易在别处拼错。
    BadName(String),
    UnknownTag(String),
}

impl SpecBlock {
    pub fn reason(&self) -> String {
        match self {
            Self::EmptyName => "用户名不能为空".to_owned(),
            Self::EmptyPassword => "新建用户必须设置密码".to_owned(),
            Self::BadName(name) => format!(
                "用户名 `{name}` 里有空白字符：AMQP URI 与命令行都容易把它拼错，建议只用字母数字与 `-` `_` `.`"
            ),
            Self::UnknownTag(tag) => format!(
                "标签 `{tag}` 不认识：只能是 administrator / monitoring / management / policymaker"
            ),
        }
    }
}

impl UserSpec {
    /// 校验。`editing` 为真时允许空密码（表示不变更）。
    pub fn validate(&self, editing: bool) -> Result<(), SpecBlock> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err(SpecBlock::EmptyName);
        }
        if name.chars().any(char::is_whitespace) {
            return Err(SpecBlock::BadName(name.to_owned()));
        }
        if !editing && self.password.is_empty() {
            return Err(SpecBlock::EmptyPassword);
        }
        for tag in &self.tags {
            if UserTag::parse(tag).is_none() {
                return Err(SpecBlock::UnknownTag(tag.clone()));
            }
        }
        Ok(())
    }

    /// 这个新用户能不能登管理界面。空标签在这里是「能填但看不到东西」，
    /// 需要在保存前提醒，而不是等用户去控制台发现。
    pub fn can_login(&self) -> bool {
        self.tags
            .iter()
            .filter_map(|tag| UserTag::parse(tag))
            .any(UserTag::can_login)
    }
}

/// 新密码的强度判断。只挡最明显的两类，不做「必须含大小写」那套。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasswordVerdict {
    /// 太短（少于 8 位）。
    TooShort,
    /// 与用户名相同。
    SameAsName,
    /// 能用。
    Ok,
}

impl PasswordVerdict {
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::TooShort => Some("密码少于 8 位"),
            Self::SameAsName => Some("密码与用户名相同"),
            Self::Ok => None,
        }
    }
}

/// 判断密码。空密码由 `UserSpec::validate` 在新建时拦下，这里不管。
pub fn check_password(name: &str, password: &str) -> PasswordVerdict {
    if password.is_empty() {
        return PasswordVerdict::Ok;
    }
    if password == name.trim() {
        return PasswordVerdict::SameAsName;
    }
    if password.chars().count() < 8 {
        return PasswordVerdict::TooShort;
    }
    PasswordVerdict::Ok
}

/// 一个 vhost 的汇总行，把队列数与权限数并进来。
///
/// 单独成结构而不是让前端自己 join：队列数与权限数是两次请求各自的产物，
/// 前端拿不到另一份数据时只会画出一个「全部为 0」的假象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VhostRow {
    #[serde(flatten)]
    pub vhost: VhostInfo,
    /// 该 vhost 下的队列数。
    pub queues: usize,
    /// 该 vhost 上的权限条数。
    pub permissions: usize,
    /// 有几条权限是全开的（三段都是 `.*`）。
    pub full_access: usize,
}

/// 把 vhost、队列数、权限数拼成一张表。
///
/// 队列数按 `queue_counts` 里的 vhost 归并；权限同理。两个来源都可能没覆盖到
/// 某个 vhost（权限列表在受限账号上常被拒），缺失时按 0 算，而不是报错整页。
pub fn assemble_vhosts(
    vhosts: &[VhostInfo],
    queue_counts: &[(String, usize)],
    permissions: &[PermissionInfo],
) -> Vec<VhostRow> {
    let mut rows: Vec<VhostRow> = vhosts
        .iter()
        .map(|vhost| {
            let queues = queue_counts
                .iter()
                .filter(|(name, _)| name == &vhost.name)
                .map(|(_, count)| *count)
                .sum();
            let matched: Vec<&PermissionInfo> = permissions
                .iter()
                .filter(|item| item.vhost == vhost.name)
                .collect();
            VhostRow {
                vhost: vhost.clone(),
                queues,
                permissions: matched.len(),
                full_access: matched.iter().filter(|item| item.is_full_access()).count(),
            }
        })
        .collect();
    rows.sort_by(|a, b| a.vhost.name.cmp(&b.vhost.name));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission(user: &str, vhost: &str, segments: [&str; 3]) -> PermissionInfo {
        PermissionInfo {
            user: user.to_owned(),
            vhost: vhost.to_owned(),
            configure: segments[0].to_owned(),
            write: segments[1].to_owned(),
            read: segments[2].to_owned(),
        }
    }

    #[test]
    fn default_vhost_cannot_be_removed() {
        // 服务端报错很含糊，界面先挡住。
        assert_eq!(check_vhost_removal("/"), Err(RemovalBlock::DefaultVhost));
        assert!(check_vhost_removal("orders").is_ok());
        assert_eq!(check_vhost_removal("  "), Err(RemovalBlock::EmptyName));
    }

    #[test]
    fn current_user_cannot_be_removed() {
        assert_eq!(
            check_user_removal("admin", "admin"),
            Err(RemovalBlock::CurrentUser("admin".to_owned()))
        );
        assert!(check_user_removal("guest", "admin").is_ok());
    }

    #[test]
    fn empty_tags_mean_no_login() {
        let user = UserInfo {
            name: "shovel".to_owned(),
            tags: Vec::new(),
        };
        // 用户建好了、密码也对，但进不去管理界面——这一点必须在界面上说清。
        assert!(!user.can_login());
        assert!(!user.is_admin());
    }

    #[test]
    fn unknown_tag_is_kept_raw_but_ignored_when_parsing() {
        let user = UserInfo {
            name: "ops".to_owned(),
            tags: vec!["administrator".to_owned(), "custom-plugin".to_owned()],
        };
        assert_eq!(user.parsed_tags(), vec![UserTag::Administrator]);
        // 原文留着，界面上照原样显示。
        assert_eq!(user.tags.len(), 2);
        assert!(user.is_admin());
    }

    #[test]
    fn full_access_permission_is_flagged() {
        let all = permission("ops", "orders", [".*", ".*", ".*"]);
        assert!(all.is_full_access());
        assert!(all.empty_segments().is_empty());

        let partial = permission("app", "orders", [".*", "orders.*", ".*"]);
        assert!(!partial.is_full_access());
    }

    #[test]
    fn empty_segments_are_named() {
        let limited = permission("app", "orders", ["", "orders.*", ""]);
        assert_eq!(limited.empty_segments(), vec!["configure", "read"]);
    }

    #[test]
    fn spec_requires_password_only_when_creating() {
        let spec = UserSpec {
            name: "ops".to_owned(),
            password: String::new(),
            tags: vec!["administrator".to_owned()],
        };
        assert_eq!(spec.validate(false), Err(SpecBlock::EmptyPassword));
        // 编辑时留空等于「不改密码」，这是管理 API 的既定语义。
        assert!(spec.validate(true).is_ok());
    }

    #[test]
    fn whitespace_in_name_is_blocked() {
        let spec = UserSpec {
            name: "ops team".to_owned(),
            password: "12345678".to_owned(),
            tags: vec!["management".to_owned()],
        };
        assert!(matches!(spec.validate(false), Err(SpecBlock::BadName(_))));
    }

    #[test]
    fn unknown_tag_is_blocked() {
        let spec = UserSpec {
            name: "ops".to_owned(),
            password: "12345678".to_owned(),
            tags: vec!["admin".to_owned()],
        };
        assert_eq!(
            spec.validate(false),
            Err(SpecBlock::UnknownTag("admin".to_owned()))
        );
    }

    #[test]
    fn password_checks_are_minimal_on_purpose() {
        assert_eq!(check_password("ops", "ops"), PasswordVerdict::SameAsName);
        assert_eq!(check_password("ops", "short"), PasswordVerdict::TooShort);
        assert_eq!(check_password("ops", "longenough"), PasswordVerdict::Ok);
        // 空密码交给 validate 判，这里不重复报错。
        assert_eq!(check_password("ops", ""), PasswordVerdict::Ok);
    }

    #[test]
    fn vhost_rows_join_queues_and_permissions() {
        let vhosts = vec![
            VhostInfo {
                name: "orders".to_owned(),
                description: String::new(),
                tracing: false,
            },
            VhostInfo {
                name: "/".to_owned(),
                description: "默认".to_owned(),
                tracing: false,
            },
        ];
        let queues = vec![("orders".to_owned(), 3usize)];
        let permissions = vec![
            permission("ops", "orders", [".*", ".*", ".*"]),
            permission("app", "orders", [".*", "orders.*", ".*"]),
        ];

        let rows = assemble_vhosts(&vhosts, &queues, &permissions);
        // 排序保证表格顺序稳定。
        assert_eq!(rows[0].vhost.name, "/");
        assert_eq!(rows[1].vhost.name, "orders");
        assert_eq!(rows[1].queues, 3);
        assert_eq!(rows[1].permissions, 2);
        assert_eq!(rows[1].full_access, 1);
        // 没有队列与权限的 vhost 按 0 算，不报错。
        assert_eq!(rows[0].queues, 0);
        assert_eq!(rows[0].permissions, 0);
    }

    #[test]
    fn tags_serialize_as_camel_case() {
        let json = serde_json::to_value(UserTag::Policymaker).expect("序列化失败");
        assert_eq!(json, serde_json::json!("policymaker"));
        let json = serde_json::to_value(UserTag::None).expect("序列化失败");
        assert_eq!(json, serde_json::json!("none"));
    }
}
