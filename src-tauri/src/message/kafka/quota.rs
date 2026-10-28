//! 配额与 SCRAM 凭据的编排。
//!
//! 两件事放在一起，是因为它们在界面上是同一屏（「准入」）的两栏：
//! 一栏说「谁被限速」，一栏说「谁能连上」。分成两个命令，
//! 是因为失败面完全不同 —— 配额读不到是常态（librdkafka 没导出），
//! SCRAM 读不到要么是权限、要么是版本，两者不该互相拖累。

use crate::broker::kafka::{KafkaClient, quota as admin};
use crate::domain::{KeyValue, QuotaSnapshot, ScramSnapshot, assemble_scram};
use crate::error::{AppError, AppResult};

/// 读取配额：配额本身 + broker 级默认值。
///
/// 配额列表为空（原因见 `broker::kafka::quota`），但 broker 默认值是能拿到的 ——
/// 那一项才是「没人被单独限速时用多少」的答案，「一张空表」不是。
pub async fn quota(client: &KafkaClient) -> AppResult<QuotaSnapshot> {
    let mut snapshot = admin::describe_quota();
    let hints = admin::default_quota_hints(client).await;
    if !hints.is_empty() {
        snapshot
            .notes
            .extend(hints.into_iter().map(default_hint_text));
    }
    Ok(snapshot)
}

/// 把 `quota.producer.default = 1048576` 这类配置读成一句话。
///
/// broker 配置的值是**裸字符串**，读它的人和读配额表的人在同一个屏幕上：
/// 表里写着 `1.00 MB/s`，注释里写着 `1048576`，没人会想到这是同一个数。
/// 那一屏唯一的实义内容就是这几行，单位丢在这一层，等于把「限速 1 MB/s」
/// 说成「限速 1048576」—— 单位不明时人只能猜，而最容易猜成「条数」。
pub fn default_hint_text(pair: KeyValue) -> String {
    let label = match pair.key.as_str() {
        "quota.producer.default" => "broker 默认生产者限速",
        "quota.consumer.default" => "broker 默认消费者限速",
        "quota.window.size.seconds" => "配额统计窗口",
        "quota.window.num" => "配额统计窗口个数",
        other => other,
    };
    let value = match pair.key.as_str() {
        "quota.producer.default" | "quota.consumer.default" => byte_rate_value_text(&pair.value),
        "quota.window.size.seconds" => format!("{} 秒", pair.value),
        other => {
            // 不认识的键原样显示，但值里的数字仍然照原样 —— 编一个单位比没有单位更糟。
            let _ = other;
            pair.value.clone()
        }
    };
    format!("{label}：{value}")
}

/// broker 配置里的字节速率。解析不了就原样返回，**不猜单位**。
fn byte_rate_value_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "未设置".to_owned();
    }
    match trimmed.parse::<f64>() {
        Ok(value) => crate::domain::byte_rate_text(value),
        Err(_) => trimmed.to_owned(),
    }
}

/// 读取 SCRAM 凭据。
///
/// 老 broker 报「不支持」时**不返回 Err**：那是这一屏的正常状态，
/// 界面要显示「这台 broker 问不了」，而不是把整页做成一个错误页。
pub async fn scram(client: &KafkaClient) -> AppResult<ScramSnapshot> {
    match admin::describe_scram(client).await {
        Ok(users) => Ok(assemble_scram(users, None)),
        Err(AppError::Unsupported(reason)) => Ok(assemble_scram(Vec::new(), Some(reason))),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_hints_read_as_sentences() {
        assert_eq!(
            default_hint_text(KeyValue::new("quota.producer.default", "1048576")),
            "broker 默认生产者限速：1.00 MB/s"
        );
        assert_eq!(
            default_hint_text(KeyValue::new("quota.window.size.seconds", "1")),
            "配额统计窗口：1 秒"
        );
    }

    #[test]
    fn byte_rate_hint_keeps_its_unit() {
        // 回归：单位在这一层被读丢，`1048576` 直接显示成裸数字，
        // 而同一份数据在配额表里是 `1.00 MB/s`。裸数字最容易被当成「条数」。
        assert_eq!(
            default_hint_text(KeyValue::new("quota.consumer.default", "512")),
            "broker 默认消费者限速：512 B/s"
        );
    }

    #[test]
    fn unparsable_value_is_not_given_a_made_up_unit() {
        // broker 给了什么就说什么：`1048576x` 不是数字，不能强行读成 1 MB/s。
        assert_eq!(
            default_hint_text(KeyValue::new("quota.producer.default", "1048576x")),
            "broker 默认生产者限速：1048576x"
        );
        // 空值既不是 0 也不是「不限速」，只能说「未设置」。
        assert_eq!(
            default_hint_text(KeyValue::new("quota.producer.default", "")),
            "broker 默认生产者限速：未设置"
        );
    }

    #[test]
    fn unknown_keys_pass_through_untouched() {
        // 新版 Kafka 加了别的 quota 配置项时，宁可原样显示也不要编一个中文名。
        assert_eq!(
            default_hint_text(KeyValue::new("quota.new.thing", "x")),
            "quota.new.thing：x"
        );
    }
}
