//! Kafka 的「谁被限了、谁有凭据」——客户端配额与 SASL/SCRAM 凭据。
//!
//! 这一块在 kafka-ui 里是「Quotas」一屏，和 ACL 一起构成多租户集群的准入面。
//! 面板之前能改主题配置、能改 broker 配置，但回答不了一个运维最常被问的问题：
//! **这个团队的分区建太多，是谁在限它？**
//!
//! 两件事都只有「看」没有「改」，这不是偷懒：
//!
//! - **配额**：librdkafka 2.12 的 C 头文件里根本没有 `DescribeClientQuotas` 的
//!   导出符号，`KafkaClient` 能拿到的只有一个不透明的 `*mut RDKafka`。
//!   要写就得绕过 librdkafka 自己发协议请求 —— 那是另一个量级的改动，不属于这一屏。
//! - **SCRAM**：`DescribeUserScramCredentials` 有导出符号（2.7.0+ broker），
//!   但改凭据需要 `AlterUserScramCredentials`，同样没有导出。
//!
//! 所以这一屏的回答是「谁被限了、限在哪」——查清楚之后管理员去 `kafka-configs.sh`
//! 或者别的工具改，比在面板里做一个半吊子写入按钮诚实。
//!
//! 判读规则（配额层级怎么读、SCRAM 能不能用）全在纯函数里，不碰网络。

use serde::{Deserialize, Serialize};

use super::KeyValue;

/// 配额实体的层级。
///
/// Kafka 的配额描述是「实体对 + 键值」，实体可以缺省，缺省的读法完全不同：
/// 没有 `client-id` 的那一条是「给这个用户的所有客户端兜底」，
/// 少了这句话，界面会把兜底规则读成「只限某个叫空字符串的客户端」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaEntityKind {
    /// 用户级配额：`user` 实体。
    User,
    /// 客户端级配额：`client-id` 实体。
    ClientId,
    /// 用户 + 客户端组合：两把钥匙一起用。
    UserClientId,
    /// 既没有用户也没有客户端：集群默认配额，所有连接的最后一道兜底。
    Default,
}

impl QuotaEntityKind {
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::User => "用户",
            Self::ClientId => "客户端",
            Self::UserClientId => "用户 + 客户端",
            Self::Default => "集群默认",
        }
    }
}

/// 一条配额记录：谁、哪一项、多少。
///
/// 不实现 `Eq`：配额值是 `f64`，服务端确实会给出小数（`request_percentage`
/// 就是百分比）。用 `PartialEq` 比较、用序列化做断言，比给浮点强加全序诚实。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaEntry {
    /// 用户实体（`Some("")` 是 Kafka 用来表示「默认用户」的空串，已在这里归一成 `None`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// 客户端实体，同样把空串归一成 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub kind: QuotaEntityKind,
    /// 配额键，例如 `producer_byte_rate`、`consumer_byte_rate`、`request_percentage`。
    pub key: String,
    pub value: f64,
}

impl QuotaEntry {
    /// 这个实体在界面上的名字。
    pub fn entity_label(&self) -> String {
        match (self.user.as_deref(), self.client_id.as_deref()) {
            (Some(user), Some(client)) => format!("{user} / {client}"),
            (Some(user), None) => format!("{user} · 全部客户端"),
            (None, Some(client)) => format!("客户端 {client} · 全部用户"),
            (None, None) => "集群默认".to_owned(),
        }
    }

    /// 值的人话：字节速率带单位，百分比与纯数不加。
    pub fn value_text(&self) -> String {
        match self.key.as_str() {
            "producer_byte_rate" | "consumer_byte_rate" => {
                format!("{}/s", byte_rate_text(self.value))
            }
            "request_percentage" => format!("{}%", trim_number(self.value)),
            _ => trim_number(self.value),
        }
    }
}

/// 字节速率：`1048576` 读成 `1.00 MB`，而不是让用户自己数零。
fn byte_rate_text(value: f64) -> String {
    if !value.is_finite() || value < 0.0 {
        return "未知".to_owned();
    }
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut scale = value;
    let mut unit = 0;
    while scale >= 1024.0 && unit + 1 < UNITS.len() {
        scale /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", trim_number(scale))
    } else {
        format!("{:.2} {}", scale, UNITS[unit])
    }
}

/// 去掉浮点数无意义的小数尾巴：`10.0` 说成 `10`。
fn trim_number(value: f64) -> String {
    if !value.is_finite() {
        return "未知".to_owned();
    }
    if (value.fract()).abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

/// 一份配额快照。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    /// 按实体聚合后的记录。
    pub entries: Vec<QuotaEntry>,
    /// 读取失败的分支原因；`None` 表示这次读取是完整的。
    ///
    /// 用 `Option<String>` 而不是 `Vec<String>`，是因为这里只有一个失败面
    /// （一次请求、一个错误），凑成数组反而让界面要多写一层「取第一条」。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 需要用户知道的事实（例如「这里是只读的，改要去 kafka-configs.sh」）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl QuotaSnapshot {
    /// 按实体分组后的视图：界面按「一个实体一块」排版，而不是一张长表。
    ///
    /// 排序刻意固定：集群默认在前（它是兜底，先看它才知道别的规则在覆盖什么），
    /// 其余按实体标签的字典序 —— 顺序稳定的表才能被记住。
    pub fn groups(&self) -> Vec<QuotaGroup> {
        let mut groups: Vec<QuotaGroup> = Vec::new();
        for entry in &self.entries {
            match groups
                .iter_mut()
                .find(|group| group.label == entry.entity_label())
            {
                Some(group) => group.items.push(entry.clone()),
                None => groups.push(QuotaGroup {
                    label: entry.entity_label(),
                    kind: entry.kind,
                    user: entry.user.clone(),
                    client_id: entry.client_id.clone(),
                    items: vec![entry.clone()],
                }),
            }
        }

        groups.sort_by(|left, right| {
            let rank = |kind: QuotaEntityKind| {
                if kind == QuotaEntityKind::Default {
                    0
                } else {
                    1
                }
            };
            rank(left.kind)
                .cmp(&rank(right.kind))
                .then_with(|| left.label.cmp(&right.label))
        });
        groups
    }

    /// 有没有任何配额。
    ///
    /// 空快照不等于「一切正常」：没配额时 Kafka 用的是 broker 端的默认值，
    /// 那通常是「不限」。界面必须把这句话说出来，否则一张空表会被读成「全部都限住了」。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 一个实体下的全部配额项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaGroup {
    pub label: String,
    pub kind: QuotaEntityKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub items: Vec<QuotaEntry>,
}

/// SASL/SCRAM 机制。Kafka 只有这两种。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScramMechanism {
    Sha256,
    Sha512,
}

impl ScramMechanism {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sha256 => "SCRAM-SHA-256",
            Self::Sha512 => "SCRAM-SHA-512",
        }
    }
}

/// 一个用户的一条凭据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScramCredential {
    pub mechanism: ScramMechanism,
    /// 迭代次数。改它会让已发出的客户端配置失效，所以必须显示出来。
    pub iterations: i32,
}

/// 一个用户的全部 SCRAM 凭据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScramUser {
    pub user: String,
    pub credentials: Vec<ScramCredential>,
    /// 这个用户自己的读取错误；有它时 `credentials` 必然是空的。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ScramUser {
    /// 这个用户是否两个机制都有凭据 —— 缺一个就意味着某类客户端连不上。
    pub fn missing_mechanisms(&self) -> Vec<&'static str> {
        [ScramMechanism::Sha256, ScramMechanism::Sha512]
            .into_iter()
            .filter(|mechanism| {
                !self
                    .credentials
                    .iter()
                    .any(|credential| credential.mechanism == *mechanism)
            })
            .map(ScramMechanism::as_str)
            .collect()
    }

    /// 一句话结论：这个用户的凭据状况。
    pub fn verdict(&self) -> String {
        if self.error.is_some() {
            return "读取失败".to_owned();
        }
        if self.credentials.is_empty() {
            return "没有 SCRAM 凭据".to_owned();
        }
        let missing = self.missing_mechanisms();
        if missing.is_empty() {
            "两种机制都有".to_owned()
        } else {
            format!("缺 {}", missing.join("、"))
        }
    }
}

/// SCRAM 凭据快照。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScramSnapshot {
    pub users: Vec<ScramUser>,
    /// broker 不支持这个 API（2.7.0 以下）时给出原因，而不是一张空表。
    ///
    /// 空表会被读成「一个 SCRAM 用户都没有」—— 而真实情况可能是
    /// 「这台 broker 根本不会回答这个问题」。两者要分开说。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl ScramSnapshot {
    pub fn is_empty(&self) -> bool {
        self.users.is_empty()
    }

    /// 有凭据但某个机制缺失的用户数：迁移到 SCRAM-SHA-512 时最容易踩的一脚。
    pub fn partial_count(&self) -> usize {
        self.users
            .iter()
            .filter(|user| user.error.is_none() && !user.missing_mechanisms().is_empty())
            .count()
    }
}

/// 把配额实体的原始键值对归一成 `(user, client_id)`。
///
/// Kafka 用空串表示「默认用户 / 默认客户端」，直接透传会让界面出现
/// 一个名叫空字符串的实体。归一成 `None` 之后，「有没有这个实体」
/// 与「这个实体的名字是什么」才分得开。
pub fn normalize_entity(pairs: &[KeyValue]) -> (Option<String>, Option<String>) {
    let pick = |key: &str| -> Option<String> {
        pairs
            .iter()
            .find(|pair| pair.key == key)
            .map(|pair| pair.value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    (pick("user"), pick("client-id"))
}

/// 由归一后的实体判断层级。
pub fn kind_of(user: Option<&str>, client_id: Option<&str>) -> QuotaEntityKind {
    match (user.is_some(), client_id.is_some()) {
        (true, true) => QuotaEntityKind::UserClientId,
        (true, false) => QuotaEntityKind::User,
        (false, true) => QuotaEntityKind::ClientId,
        (false, false) => QuotaEntityKind::Default,
    }
}

/// 组装一份配额快照：排序 + 去重 + 补上必须说清的话。
///
/// 去重是必要的：同一个实体的同一个键被服务端回了两遍时，界面上会出现
/// 两行一样的数字，用户会以为是两套规则。保留后出现的那条（服务端顺序即优先级）。
pub fn assemble_quota(entries: Vec<QuotaEntry>, error: Option<String>) -> QuotaSnapshot {
    let mut deduped: Vec<QuotaEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        let duplicate = deduped.iter_mut().find(|existing| {
            existing.user == entry.user
                && existing.client_id == entry.client_id
                && existing.key == entry.key
        });
        match duplicate {
            Some(existing) => *existing = entry,
            None => deduped.push(entry),
        }
    }

    let mut notes = Vec::new();
    if deduped.is_empty() && error.is_none() {
        // 空表不能读成「没有人被限速」：这里压根没读到，不是一个结论。
        notes.push(
            "这张列表不是「没有配额」：面板当前读不到配额（librdkafka 未导出 \
             DescribeClientQuotas），空表只表示「没查」。下面只能给出 broker 级默认值"
                .to_owned(),
        );
    }
    notes.push(
        "面板只能查看配额：librdkafka 尚未导出 DescribeClientQuotas，改配额请用 kafka-configs.sh"
            .to_owned(),
    );

    QuotaSnapshot {
        entries: deduped,
        error,
        notes,
    }
}

/// 组装 SCRAM 快照：按用户名排序，并标出「只读」这件事。
pub fn assemble_scram(users: Vec<ScramUser>, unsupported: Option<String>) -> ScramSnapshot {
    let mut sorted = users;
    sorted.sort_by(|left, right| left.user.cmp(&right.user));

    let mut notes =
        vec!["只能看到机制与迭代次数，看不到盐值和派生密钥 —— 服务端从不返回后者".to_owned()];
    if sorted
        .iter()
        .any(|user| !user.missing_mechanisms().is_empty() && user.error.is_none())
    {
        notes.push("有用户只配了其中一种机制：用另一种机制连接的客户端会直接认证失败".to_owned());
    }
    if unsupported.is_none() {
        notes.push("修改或删除凭据需要 AlterUserScramCredentials，面板暂不提供".to_owned());
    }

    ScramSnapshot {
        users: sorted,
        unsupported,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(user: Option<&str>, client: Option<&str>, key: &str, value: f64) -> QuotaEntry {
        QuotaEntry {
            user: user.map(str::to_owned),
            client_id: client.map(str::to_owned),
            kind: kind_of(user, client),
            key: key.to_owned(),
            value,
        }
    }

    #[test]
    fn empty_entity_strings_become_none() {
        let pairs = vec![
            KeyValue::new("user", ""),
            KeyValue::new("client-id", " ingest "),
        ];
        assert_eq!(normalize_entity(&pairs), (None, Some("ingest".to_owned())));
    }

    #[test]
    fn entity_kind_follows_missing_half() {
        assert_eq!(
            kind_of(Some("alice"), Some("app")),
            QuotaEntityKind::UserClientId
        );
        assert_eq!(kind_of(Some("alice"), None), QuotaEntityKind::User);
        assert_eq!(kind_of(None, Some("app")), QuotaEntityKind::ClientId);
        assert_eq!(kind_of(None, None), QuotaEntityKind::Default);
    }

    #[test]
    fn default_quota_reads_as_fallback_not_empty_client() {
        let quota = entry(None, None, "producer_byte_rate", 1_048_576.0);
        assert_eq!(quota.entity_label(), "集群默认");
    }

    #[test]
    fn byte_rate_is_scaled() {
        assert_eq!(
            entry(None, None, "producer_byte_rate", 1_048_576.0).value_text(),
            "1.00 MB/s"
        );
        assert_eq!(
            entry(None, None, "consumer_byte_rate", 512.0).value_text(),
            "512 B/s"
        );
    }

    #[test]
    fn request_percentage_keeps_percent_sign() {
        assert_eq!(
            entry(Some("a"), None, "request_percentage", 75.0).value_text(),
            "75%"
        );
    }

    #[test]
    fn duplicate_key_keeps_the_last_one() {
        let snapshot = assemble_quota(
            vec![
                entry(Some("a"), None, "producer_byte_rate", 1.0),
                entry(Some("a"), None, "producer_byte_rate", 2.0),
            ],
            None,
        );
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].value, 2.0);
    }

    #[test]
    fn default_quota_sorts_first() {
        let snapshot = assemble_quota(
            vec![
                entry(Some("zeta"), None, "producer_byte_rate", 1.0),
                entry(None, None, "producer_byte_rate", 2.0),
            ],
            None,
        );
        let groups = snapshot.groups();
        assert_eq!(groups[0].kind, QuotaEntityKind::Default);
        assert_eq!(groups[1].label, "zeta · 全部客户端");
    }

    #[test]
    fn empty_snapshot_says_it_is_not_a_clean_result() {
        // 空表必须说清「没查到」，而不是「没人被限速」——
        // 后者会让用户以为放行名单是干净的。
        let snapshot = assemble_quota(Vec::new(), None);
        assert!(snapshot.is_empty());
        assert!(snapshot.notes.iter().any(|note| note.contains("没查")));
        assert!(!snapshot.notes.iter().any(|note| note.contains("不限速")));
    }

    #[test]
    fn error_snapshot_does_not_claim_health() {
        let snapshot = assemble_quota(Vec::new(), Some("权限不足".to_owned()));
        assert_eq!(snapshot.error.as_deref(), Some("权限不足"));
        // 报错时不能再补「没查到配额」这类解释——错误本身已经把话说清了。
        assert!(!snapshot.notes.iter().any(|note| note.contains("这张列表")));
    }

    #[test]
    fn scram_user_reports_missing_mechanism() {
        let user = ScramUser {
            user: "alice".to_owned(),
            credentials: vec![ScramCredential {
                mechanism: ScramMechanism::Sha256,
                iterations: 4096,
            }],
            error: None,
        };
        assert_eq!(user.missing_mechanisms(), vec!["SCRAM-SHA-512"]);
        assert_eq!(user.verdict(), "缺 SCRAM-SHA-512");
    }

    #[test]
    fn scram_user_with_both_mechanisms_is_complete() {
        let user = ScramUser {
            user: "alice".to_owned(),
            credentials: vec![
                ScramCredential {
                    mechanism: ScramMechanism::Sha256,
                    iterations: 4096,
                },
                ScramCredential {
                    mechanism: ScramMechanism::Sha512,
                    iterations: 8192,
                },
            ],
            error: None,
        };
        assert!(user.missing_mechanisms().is_empty());
        assert_eq!(user.verdict(), "两种机制都有");
    }

    #[test]
    fn scram_snapshot_counts_partial_users() {
        let snapshot = assemble_scram(
            vec![
                ScramUser {
                    user: "b".to_owned(),
                    credentials: vec![ScramCredential {
                        mechanism: ScramMechanism::Sha256,
                        iterations: 4096,
                    }],
                    error: None,
                },
                ScramUser {
                    user: "a".to_owned(),
                    credentials: Vec::new(),
                    error: Some("权限不足".to_owned()),
                },
            ],
            None,
        );
        assert_eq!(snapshot.users[0].user, "a");
        assert_eq!(snapshot.partial_count(), 1);
        assert!(snapshot.notes.iter().any(|note| note.contains("认证失败")));
    }

    #[test]
    fn unsupported_broker_does_not_look_like_zero_users() {
        let snapshot = assemble_scram(Vec::new(), Some("broker 版本低于 2.7.0".to_owned()));
        assert!(snapshot.is_empty());
        assert!(snapshot.unsupported.is_some());
        // 不支持时不该再补「修改需要 Alter…」那句：它连读都不行。
        assert!(
            !snapshot
                .notes
                .iter()
                .any(|note| note.contains("AlterUserScramCredentials"))
        );
    }
}
