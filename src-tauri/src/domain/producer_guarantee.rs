//! producer 的端到端保证：幂等、确认、重试窗口，以及它们被谁悄悄改掉。
//!
//! `enable.idempotence=true` 不是一个生效即完事的开关，它有一组前提：
//! `acks=all`、`max.in.flight.requests.per.connection <= 5`、`retries > 0`、
//! `retry.backoff.ms == 0`。用户填的高级选项会覆盖我们写死的值，
//! 而 librdkafka 的处置是**关掉幂等并继续发送**——不报错、不警告，
//! 于是界面上一句「重发是安全的」在后台已经不成立了。
//!
//! 这里做两件事：判断「用户填的这一项会不会关掉幂等」，以及把结论说成人话。
//! 全是纯函数，不碰 librdkafka。

use std::collections::BTreeMap;

/// 幂等的下限：单连接内未确认请求数超过它，broker 就无法替你判重。
///
/// librdkafka 的处置是「把幂等关掉」，不是报错 —— 这正是要自己检查的原因。
pub const MAX_IN_FLIGHT_FOR_IDEMPOTENCE: u32 = 5;

/// 一次检查的结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerGuarantee {
    /// 幂等是否仍然生效。
    pub idempotent: bool,
    /// 给界面看的说明。`idempotent` 为真时是「这些默认值在起作用」的那一句，
    /// 为假时说清是哪一项把幂等关掉了、以及这意味着什么。
    pub note: String,
    /// 被用户选项覆盖掉的受保护项，顺序固定为
    /// `enable.idempotence` → `acks` → `max.in.flight` → `retries` → `retry.backoff.ms`。
    pub overridden: Vec<String>,
}

impl ProducerGuarantee {
    /// 幂等失效时给界面的警告；仍然生效时返回 `None`。
    pub fn warning(&self) -> Option<String> {
        (!self.idempotent).then(|| self.note.clone())
    }
}

/// 检查用户填的高级选项把 producer 的哪些保证改掉了。
///
/// 入参是**用户填的**选项（`KafkaConfig.options`），不是最终配置：
/// 混在一起就分不清一个值是我们写的还是他写的，而只有后者需要解释。
pub fn inspect(options: &BTreeMap<String, String>) -> ProducerGuarantee {
    // librdkafka 的配置名不区分大小写，用户写 `Enable.Idempotence` 一样生效。
    let lowered = options
        .iter()
        .filter(|(key, _)| !key.trim().is_empty())
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();

    let get = |key: &str| lowered.get(key).map(String::as_str);

    let mut overridden = Vec::new();
    let mut reasons = Vec::new();

    // 显式关掉幂等是用户的自由，但要说清代价。
    if matches!(get("enable.idempotence"), Some("false")) {
        overridden.push("enable.idempotence".to_owned());
        reasons.push("高级选项里关掉了 enable.idempotence".to_owned());
    }

    // `acks` 不是 all 时幂等不成立：判重依赖 leader 等到全部 ISR 确认。
    if let Some(acks) = get("acks")
        && !acks.eq_ignore_ascii_case("all")
        && acks != "-1"
    {
        overridden.push("acks".to_owned());
        reasons.push(format!(
            "acks={acks}（幂等要求 all）→ 「已写入」只代表 leader 收到了，\
             重启或切主时这条消息可能消失"
        ));
    }

    // 未确认请求数超过 5 时 librdkafka 会关掉幂等，重试也就可能打乱分区内顺序。
    if let Some(value) = get("max.in.flight.requests.per.connection") {
        match value.parse::<u32>() {
            Ok(n) if n > MAX_IN_FLIGHT_FOR_IDEMPOTENCE => {
                overridden.push("max.in.flight.requests.per.connection".to_owned());
                reasons.push(format!(
                    "max.in.flight.requests.per.connection={n}（上限 \
                     {MAX_IN_FLIGHT_FOR_IDEMPOTENCE}）→ 幂等会被关掉，\
                     重试还会打乱同一分区内的消息顺序"
                ));
            }
            // 写了个解析不出来的值时不要猜：librdkafka 会自己拒绝掉这个配置，
            // 但「拒绝」是在建客户端那一刻才发生，这里说「生效中」比不说更糟。
            Ok(_) => {}
            Err(_) => {
                overridden.push("max.in.flight.requests.per.connection".to_owned());
                reasons.push(format!(
                    "max.in.flight.requests.per.connection={value} 不是数字，\
                     客户端可能直接拒绝这个值"
                ));
            }
        }
    }

    if matches!(get("retries"), Some("0")) {
        overridden.push("retries".to_owned());
        reasons.push("retries=0 → 幂等要求重试次数大于 0，这条设置会把幂等关掉".to_owned());
    }

    if let Some(value) = get("retry.backoff.ms")
        && value.parse::<u32>().map(|ms| ms > 0).unwrap_or(true)
    {
        overridden.push("retry.backoff.ms".to_owned());
        reasons.push(format!(
            "retry.backoff.ms={value}（幂等要求 0）→ 幂等会被关掉"
        ));
    }

    if reasons.is_empty() {
        return ProducerGuarantee {
            idempotent: true,
            note: "幂等在生效：发出的消息带 producer id，broker 会替你丢掉同一实例内的重复重试"
                .to_owned(),
            overridden,
        };
    }

    ProducerGuarantee {
        idempotent: false,
        note: format!(
            "这条连接上幂等已失效：{}。\
             重发超时后再点一次可能留下两条一样的消息——先刷新确认，别直接再发",
            reasons.join("；")
        ),
        overridden,
    }
}

/// 发送成功时附在结论后面的那句「顺带提醒」。
///
/// 只在幂等失效时出现：成功提示最容易被当成「以后也可以放心再点」，
/// 而这正是幂等失效后不成立的那个假设。
pub fn success_footnote(guarantee: &ProducerGuarantee) -> Option<String> {
    guarantee
        .warning()
        .map(|warning| format!("注意：{warning}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn empty_options_keep_idempotence() {
        let verdict = inspect(&BTreeMap::new());
        assert!(verdict.idempotent);
        assert!(verdict.overridden.is_empty());
        assert_eq!(verdict.warning(), None);
        assert!(success_footnote(&verdict).is_none());
    }

    #[test]
    fn flight_limit_above_five_disables_idempotence() {
        let verdict = inspect(&options(&[("max.in.flight.requests.per.connection", "10")]));
        assert!(!verdict.idempotent);
        assert_eq!(
            verdict.overridden,
            vec!["max.in.flight.requests.per.connection".to_owned()]
        );
        // 说明里要点出「幂等被关掉」和「顺序会被打乱」这两件不同的事。
        assert!(verdict.note.contains("幂等会被关掉"), "{}", verdict.note);
        assert!(verdict.note.contains("顺序"), "{}", verdict.note);
    }

    #[test]
    fn flight_limit_at_the_boundary_stays_idempotent() {
        // 5 是上限本身，不是超限：把合法的值当警告报，等于让人关掉一条正确的配置。
        let verdict = inspect(&options(&[("max.in.flight.requests.per.connection", "5")]));
        assert!(verdict.idempotent);
    }

    #[test]
    fn acks_one_disables_idempotence() {
        let verdict = inspect(&options(&[("acks", "1")]));
        assert!(!verdict.idempotent);
        assert!(verdict.note.contains("acks=1"), "{}", verdict.note);
    }

    #[test]
    fn acks_all_and_minus_one_both_count() {
        for value in ["all", "ALL", "-1"] {
            let verdict = inspect(&options(&[("acks", value)]));
            assert!(verdict.idempotent, "acks={value} 应当成立");
        }
    }

    #[test]
    fn retries_zero_disables_idempotence() {
        let verdict = inspect(&options(&[("retries", "0")]));
        assert!(!verdict.idempotent);
    }

    #[test]
    fn key_case_is_ignored_like_librdkafka_does() {
        let verdict = inspect(&options(&[("Enable.Idempotence", "false")]));
        assert!(!verdict.idempotent);
        assert_eq!(verdict.overridden, vec!["enable.idempotence".to_owned()]);
    }

    #[test]
    fn several_overrides_are_reported_in_a_stable_order() {
        let verdict = inspect(&options(&[
            ("max.in.flight.requests.per.connection", "9"),
            ("acks", "1"),
        ]));
        assert_eq!(
            verdict.overridden,
            vec![
                "acks".to_owned(),
                "max.in.flight.requests.per.connection".to_owned()
            ]
        );
        assert!(verdict.note.contains("acks=1"), "{}", verdict.note);
        assert!(verdict.note.contains("=9"), "{}", verdict.note);
        // 失效时都要落到同一句「先刷新确认，别直接再发」上，否则等于没说。
        assert!(verdict.note.contains("别直接再发"), "{}", verdict.note);
    }

    #[test]
    fn unrelated_options_are_not_reported() {
        let verdict = inspect(&options(&[
            ("compression.type", "lz4"),
            ("linger.ms", "5"),
            ("retry.backoff.ms", "0"),
        ]));
        assert!(verdict.idempotent);
        assert!(verdict.overridden.is_empty());
    }

    #[test]
    fn non_numeric_flight_limit_is_called_out() {
        let verdict = inspect(&options(&[(
            "max.in.flight.requests.per.connection",
            "five",
        )]));
        assert!(!verdict.idempotent);
        assert!(verdict.note.contains("不是数字"), "{}", verdict.note);
    }

    #[test]
    fn success_footnote_only_appears_when_broken() {
        let broken = inspect(&options(&[("acks", "1")]));
        let footnote = success_footnote(&broken).expect("失效时应有附注");
        assert!(footnote.starts_with("注意："), "{footnote}");
    }
}
