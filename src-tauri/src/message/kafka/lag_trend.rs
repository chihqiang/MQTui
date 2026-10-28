//! 消费组滞后趋势采样：同一份进度读两次，中间隔一段时间。
//!
//! 实现比主题吞吐更省事，也更准确：`fetch_committed_offsets` 本来就要为每个
//! 分区读一次 `high` 才能算滞后，所以「读一次详情」已经是一次完整的快照，
//! 不需要另找数据源。这里只做两件事 —— 间隔、两次、交给
//! `domain::lag_trend` 算差值。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rdkafka::ClientConfig;
use rdkafka::consumer::BaseConsumer;

use crate::broker::kafka::{KafkaClient, admin};
use crate::domain::group_assignment::partition_query;
use crate::domain::lag_trend::{LagSample, LagTrend, compute};
use crate::error::{AppError, AppResult};

/// 采样间隔的可选范围，与界面下拉框一一对应。
pub const DEFAULT_WINDOW_MS: u64 = 5_000;

/// 窗口上限：一分钟。等太久用户就走了，排障时一分钟够看出方向。
pub const MAX_WINDOW_MS: u64 = 60_000;

/// 校验并收敛采样间隔。
///
/// 下限复用 `domain` 里的 `MIN_WINDOW_MS`：两处口径必须一致，
/// 否则「间隔不足一秒」在这里能过、到算差值时又被判成噪音。
pub fn normalize_window(window_ms: Option<u64>) -> AppResult<u64> {
    let window = window_ms.unwrap_or(DEFAULT_WINDOW_MS);
    if window < crate::domain::MIN_WINDOW_MS {
        return Err(AppError::Invalid(format!(
            "采样间隔至少 {} 毫秒，否则抖动会盖过真实趋势",
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

/// 采样一个消费组的滞后趋势。
///
/// 只读：`enable.auto.commit = false`，且两次采样用的是同一个 consumer，
/// 中间没有别的命令能插进来改位点。
pub async fn sample(
    client: &KafkaClient,
    group: &str,
    window_ms: Option<u64>,
) -> AppResult<LagTrend> {
    let name = group.trim().to_owned();
    if name.is_empty() {
        return Err(AppError::Invalid("消费组名称不能为空".to_owned()));
    }
    let window = normalize_window(window_ms)?;

    let worker = Arc::new(build(&sampling_config(client, &name))?);

    tokio::task::spawn_blocking(move || run(&worker, &name, window))
        .await
        .map_err(|error| AppError::Internal(format!("滞后采样任务失败: {error}")))?
}

/// 同步实现：采一次 → 等 → 再采一次。
fn run(worker: &BaseConsumer, group: &str, window_ms: u64) -> AppResult<LagTrend> {
    let first = snapshot(worker, group)?;
    std::thread::sleep(Duration::from_millis(window_ms));
    let second = snapshot(worker, group)?;
    Ok(compute(group, &first, &second))
}

/// 读一次完整快照。
///
/// 探针查询放在前面是一道刻意的闸门：组不存在时 `committed_offsets`
/// 只会返回一张空表，算出来是「滞后 0、无法比较」—— 那是在说一个不存在的组
/// 很健康。先确认组在，再谈它的位点。
fn snapshot(worker: &BaseConsumer, group: &str) -> AppResult<LagSample> {
    admin::probe_group(worker, group)?;
    // 分区表必须先读出来：`committed_offsets` 查的是「表里列出的分区」，
    // 空表等于没查（会算成「滞后 0、持平」）。归属也顺手拿到了，
    // 顺便能判断「这个组根本没有分区」和「读不到归属」的区别。
    let assignment = admin::fetch_assignment(worker, group)?;
    let offsets = admin::fetch_committed_offsets(worker, group, &partition_query(&assignment))?;
    Ok(LagSample::new(now_ms(), offsets))
}

/// 采样用的 consumer 配置。
///
/// 以组名作为 `group.id` 是必须的：`committed_offsets` 只认当前 consumer
/// 的 group.id。`enable.auto.commit = false` 同样是必须的 —— 面板只读，
/// 绝不能把位点写回业务组。
fn sampling_config(client: &KafkaClient, group: &str) -> ClientConfig {
    let mut config = client.consumer_config(group);
    config
        .set("enable.auto.commit", "false")
        .set("socket.timeout.ms", "10000");
    config
}

fn build(config: &ClientConfig) -> AppResult<BaseConsumer> {
    config
        .create()
        .map_err(|error| AppError::Broker(format!("创建 Kafka 查询客户端失败: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{KafkaAuth, KafkaConfig, TlsMode};

    fn client() -> KafkaClient {
        // 不建连：参数校验在发出任何请求之前就该失败。
        KafkaClient::detached(&KafkaConfig {
            brokers: vec!["127.0.0.1:9092".to_owned()],
            tls: TlsMode::Disabled,
            auth: KafkaAuth::default(),
            options: Default::default(),
        })
        .expect("构造客户端")
    }

    fn block<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("建 runtime")
            .block_on(future)
    }

    #[test]
    fn empty_group_name_is_rejected_before_any_network_call() {
        let error = block(sample(&client(), "  ", None)).unwrap_err();
        assert!(error.to_string().contains("不能为空"), "{error}");
    }

    #[test]
    fn too_short_window_is_rejected_before_any_network_call() {
        let error = block(sample(
            &client(),
            "orders-worker",
            Some(crate::domain::MIN_WINDOW_MS - 1),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("采样间隔"), "{error}");
    }

    #[test]
    fn window_defaults_and_clamps() {
        assert_eq!(
            normalize_window(None).expect("默认值可用"),
            DEFAULT_WINDOW_MS
        );
        assert_eq!(
            normalize_window(Some(10 * 60_000)).expect("上限放行"),
            MAX_WINDOW_MS
        );
    }

    #[test]
    fn sampling_config_is_read_only_and_targets_the_group() {
        // `committed_offsets` 只认当前 consumer 的 group.id，所以配置必须
        // 以组名为 group.id 建出来，并且绝不能自动提交。
        let config = sampling_config(&client(), "orders-worker");
        assert_eq!(config.get("group.id"), Some("orders-worker"));
        assert_eq!(config.get("enable.auto.commit"), Some("false"));
    }
}
