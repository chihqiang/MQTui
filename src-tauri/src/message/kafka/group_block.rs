//! 消费组「队头阻塞」采样：读两次组内进度，找「有滞后却不前进」的分区。
//!
//! 与滞后趋势同源（都是读两次 `fetch_detail`），但结论完全不同：
//! 趋势回答「积压是在涨还是在降」，这里回答「有没有分区卡死了」。
//! 前者是一个数字的方向，后者是一份名单 —— 分开成两个命令是因为
//! 用户想看的时机不一样，合并会把两件事的话术搅在一起。
//!
//! 成员与分区的归属关系另走 `fetch_assignment`（分配是成员自带的二进制
//! `MemberAssignment`，`fetch_detail` 只读位点）。读不到时留空，
//! 界面按「不知道」显示，而不是猜一个 —— 「这个分区压在谁身上」猜错
//! 比不显示更糟：它会把人引去停一个无辜的消费者。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rdkafka::ClientConfig;
use rdkafka::consumer::BaseConsumer;

use crate::broker::kafka::{KafkaClient, admin};
use crate::domain::{BlockReport, ConsumerGroupDetail, detect_group_block};
use crate::error::{AppError, AppResult};

/// 默认采样窗口。判「有没有动」比判「动得多快」更宽容，
/// 但太短会把正常的一次 poll 当成卡住，所以比滞后趋势略长。
pub const DEFAULT_WINDOW_MS: u64 = 10_000;

/// 窗口上限：两分钟。看清楚「一动不动」不需要更久。
pub const MAX_WINDOW_MS: u64 = 120_000;

/// 校验并收敛采样间隔。
pub fn normalize_window(window_ms: Option<u64>) -> AppResult<u64> {
    let window = window_ms.unwrap_or(DEFAULT_WINDOW_MS);
    if window < crate::domain::MIN_WINDOW_MS {
        return Err(AppError::Invalid(format!(
            "采样间隔至少 {} 毫秒，否则正常的一次批量拉取也会被当成卡住",
            crate::domain::MIN_WINDOW_MS
        )));
    }
    Ok(window.min(MAX_WINDOW_MS))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|span| span.as_millis() as u64)
        .unwrap_or_default()
}

/// 采样并判定队头阻塞。
pub async fn sample(
    client: &KafkaClient,
    group: &str,
    window_ms: Option<u64>,
) -> AppResult<BlockReport> {
    let name = group.trim().to_owned();
    if name.is_empty() {
        return Err(AppError::Invalid("消费组名称不能为空".to_owned()));
    }
    let window = normalize_window(window_ms)?;

    let worker = Arc::new(build(&sampling_config(client, &name))?);

    let (mut report, elapsed) = tokio::task::spawn_blocking(move || run(&worker, &name, window))
        .await
        .map_err(|error| AppError::Internal(format!("队头阻塞采样任务失败: {error}")))??;
    // 窗口长度写进结论：用户需要知道这段时间里「没动」意味着什么。
    // 用的是**两次采样之间实际过去的时间**，不是请求里的 `window` ——
    // 后一问一答各要一次往返，真实间隔总比请求里的长一点；而消费者恰好在这段
    // 多出来的时间里推进了，就会被判成「动了」。把真实数字说出来，结论才对得上。
    report.detail = format!("{:.0} 秒窗口：{}", elapsed as f64 / 1000.0, report.detail);
    Ok(report)
}

/// 同步实现：采一次 → 等 → 再采一次 → 判读。
fn run(worker: &BaseConsumer, group: &str, window_ms: u64) -> AppResult<(BlockReport, u64)> {
    // 先确认组在：不存在的组会返回空表，判出来是「整组未推进」——
    // 那是在说一个不存在的组很健康。
    admin::probe_group(worker, group)?;
    let before: ConsumerGroupDetail = admin::fetch_detail(worker, group)?;
    let sampled_at = now_ms();
    std::thread::sleep(Duration::from_millis(window_ms));
    let after = admin::fetch_detail(worker, group)?;
    // 两次快照之间真正的间隔，由两次读数的时刻决定，而不是由请求参数决定。
    let elapsed = now_ms().saturating_sub(sampled_at);

    // 归属读不到就退回空列表（不是猜）。这里的取舍是单向的：
    // `detect_group_block` 只把归属当补充信息，缺了不影响「谁没动」这个结论。
    let assignment = admin::fetch_assignment(worker, group).ok();
    let owners = |topic: &str, partition: i32| -> Vec<String> {
        assignment
            .as_ref()
            .map(|item| item.owners_of(topic, partition))
            .unwrap_or_default()
    };
    Ok((detect_group_block(&before, &after, &owners), elapsed))
}

/// 采样用的 consumer：组名即 `group.id`，绝不自动提交。
fn sampling_config(client: &KafkaClient, group: &str) -> ClientConfig {
    let mut config = client.consumer_config(group);
    config.set("enable.auto.commit", "false");
    config
}

fn build(config: &ClientConfig) -> AppResult<BaseConsumer> {
    config.create().map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_defaults_to_ten_seconds() {
        assert_eq!(
            normalize_window(None).expect("默认值可用"),
            DEFAULT_WINDOW_MS
        );
    }

    #[test]
    fn window_is_clamped_to_two_minutes() {
        assert_eq!(
            normalize_window(Some(10 * 60_000)).expect("上限应当放行"),
            MAX_WINDOW_MS
        );
    }

    #[test]
    fn sub_second_window_is_rejected_with_reason() {
        let error = normalize_window(Some(crate::domain::MIN_WINDOW_MS - 1)).unwrap_err();
        assert!(error.to_string().contains("采样间隔"), "{error}");
    }
}
