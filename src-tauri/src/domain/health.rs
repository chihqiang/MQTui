//! 连接健康检查的领域模型。
//!
//! 面板属于「先看一眼再动手」的工具：连接是否还活着、管理 API 是否可用、
//! 管理 API 是否允许写操作，这三件事决定了页面上哪些按钮该亮着。
//! 与其让用户点了报错才知道，不如进页面就探测一次。

use serde::{Deserialize, Serialize};

/// 探测项的结论。三态比布尔值更贴近事实：不知道 ≠ 不可用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    /// 探测通过。
    Ok,
    /// 探测明确失败。
    Failed,
    /// 未探测或探测结果不适用（例如 Kafka 没有管理 API）。
    Unknown,
}

impl CheckStatus {
    pub const fn from_bool(ok: bool) -> Self {
        if ok { Self::Ok } else { Self::Failed }
    }

    /// 只有明确通过才算通过，避免 `Unknown` 被误当成可用。
    pub fn is_ok(self) -> bool {
        matches!(self, Self::Ok)
    }
}

/// 一个探测项。
///
/// 只向下序列化（后端生成、前端消费），因此不必实现 `Deserialize`——
/// 那会因为 `&'static str` 字段而引入无谓的生命周期约束。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    /// 稳定标识（`amqp` / `management` / `writeAccess`），前端按它决定按钮状态。
    pub key: &'static str,
    /// 展示名。
    pub label: &'static str,
    pub status: CheckStatus,
    /// 补充说明：成功时是细节（版本号等），失败时是原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl HealthCheck {
    pub fn new(key: &'static str, label: &'static str, status: CheckStatus) -> Self {
        Self {
            key,
            label,
            status,
            detail: None,
        }
    }

    /// 附加说明。空白字符串按「没有说明」处理，避免页面出现一个空的详情位。
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into().trim().to_owned();
        if !detail.is_empty() {
            self.detail = Some(detail);
        }
        self
    }
}

/// 写操作权限探测的稳定 key，前端据此判断「能不能删队列 / 建交换机」。
pub const WRITE_ACCESS_KEY: &str = "writeAccess";

/// 一次健康检查的完整结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub items: Vec<HealthCheck>,
    /// 探测时间（毫秒时间戳），前端用来显示「几秒前」。
    pub checked_at: i64,
}

impl HealthReport {
    /// 是否支持写操作（删除队列、新建交换机等）。
    pub fn write_allowed(&self) -> bool {
        self.items
            .iter()
            .any(|item| item.key == WRITE_ACCESS_KEY && item.status.is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_camel_case_and_derives_from_bool() {
        assert_eq!(
            serde_json::to_string(&CheckStatus::Ok).expect("序列化失败"),
            "\"ok\""
        );
        assert_eq!(CheckStatus::from_bool(true), CheckStatus::Ok);
        assert_eq!(CheckStatus::from_bool(false), CheckStatus::Failed);
        assert!(!CheckStatus::Unknown.is_ok());
    }

    #[test]
    fn empty_detail_is_not_serialized() {
        let check = HealthCheck::new("amqp", "AMQP", CheckStatus::Ok).with_detail("  ");
        assert!(check.detail.is_none());
        let json = serde_json::to_value(&check).expect("序列化失败");
        assert!(json.get("detail").is_none());
        assert_eq!(json["status"], "ok");
    }

    #[test]
    fn write_access_requires_explicit_ok() {
        let mut report = HealthReport {
            items: vec![HealthCheck::new(
                WRITE_ACCESS_KEY,
                "写权限",
                CheckStatus::Unknown,
            )],
            checked_at: 0,
        };
        assert!(!report.write_allowed());

        report.items[0].status = CheckStatus::Ok;
        assert!(report.write_allowed());
    }
}
