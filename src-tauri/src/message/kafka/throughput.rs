//! 主题吞吐采样：同一份水位读两次，中间隔一段时间。
//!
//! 为什么是「读两次」而不是「查一次管理接口」：Kafka 没有现成的速率接口，
//! JMX 里的 `BytesInPerSec` 要另外开端口、另外配认证，一个排查面板不该为此
//! 要求用户去改 broker 配置。位点本身就够了 —— 写入必然推高 `high`。
//!
//! 两轮采样共用同一个 consumer，并且**只查一次元数据**：分区数是这两轮之间
//! 唯一可能变的东西，每轮各查一次元数据没有意义，还会把窗口拉长。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;

use crate::broker::kafka::KafkaClient;
use crate::domain::{
    MIN_WINDOW_MS, PartitionWatermark, TopicSample, TopicThroughput, compute_throughput,
};
use crate::error::{AppError, AppResult};

/// 单次水位查询的超时。分区间串行，给短一点，让失败尽快暴露。
const WATERMARK_TIMEOUT: Timeout = Timeout::After(Duration::from_secs(5));

/// 元数据查询超时。
const METADATA_TIMEOUT: Timeout = Timeout::After(Duration::from_secs(10));

/// 一轮采样的总超时。分区特别多时逐个查水位会变慢，但再慢也不该无限等。
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(20);

/// 采样间隔的可选范围，与界面下拉框一一对应。
pub const DEFAULT_WINDOW_MS: u64 = 5_000;

/// 窗口上限。等太久用户就走了，而且排障时 30 秒够看出「在涨还是在停」。
pub const MAX_WINDOW_MS: u64 = 60_000;

/// 校验并收敛采样间隔。
///
/// 不给「随便传」的自由：小于 `MIN_WINDOW_MS` 的间隔算出来的速率是噪音，
/// 大于一分钟的等待在交互上等于卡死。两端都夹住，并给出可直接展示的原因。
pub fn normalize_window(window_ms: Option<u64>) -> AppResult<u64> {
    let window = window_ms.unwrap_or(DEFAULT_WINDOW_MS);
    if window < MIN_WINDOW_MS {
        return Err(AppError::Invalid(format!(
            "采样间隔至少 {MIN_WINDOW_MS} 毫秒，否则速率会被抖动盖住"
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

/// 采样一个主题的吞吐。
///
/// 阻塞部分（元数据 + 两次水位）整块丢进 `spawn_blocking`：`rdkafka` 的调用
/// 是同步的，留在 async 上下文里会把整个运行时的一个线程占满，而这里的等待
/// 时间有一半是 `sleep`，白占着线程没有好处。
pub async fn sample(
    client: &KafkaClient,
    topic: &str,
    window_ms: Option<u64>,
) -> AppResult<TopicThroughput> {
    let name = topic.trim().to_owned();
    if name.is_empty() {
        return Err(AppError::Invalid("主题名称不能为空".to_owned()));
    }
    let window = normalize_window(window_ms)?;

    let config = client.consumer_config(&format!("mqtui-throughput-{}", uuid::Uuid::new_v4()));
    let worker: Arc<BaseConsumer> = Arc::new(
        config
            .create()
            .map_err(|error| AppError::Broker(format!("创建 Kafka 查询客户端失败: {error}")))?,
    );

    tokio::task::spawn_blocking(move || run(&worker, &name, window))
        .await
        .map_err(|error| AppError::Internal(format!("吞吐采样任务失败: {error}")))?
}

/// 同步实现：拿到分区清单 → 采一次 → 等 → 再采一次。
fn run(worker: &BaseConsumer, topic: &str, window_ms: u64) -> AppResult<TopicThroughput> {
    let partitions = resolve_partitions(worker, topic)?;

    let first = collect(worker, topic, &partitions)?;
    std::thread::sleep(Duration::from_millis(window_ms));
    // 第二轮重新读一次分区清单：窗口里刚好扩容的话，新分区没有基线，
    // 不猜它的速率（`compute_throughput` 会跳过它）。
    let again = resolve_partitions(worker, topic).unwrap_or_else(|_| partitions.clone());
    let second = collect(worker, topic, &again)?;

    Ok(compute_throughput(topic, &first, &second))
}

/// 取主题的分区号清单。主题不存在时直接报错 —— 传空快照算出来会是「0/s」，
/// 那是在假装一个不存在的主题很健康。
fn resolve_partitions(worker: &BaseConsumer, topic: &str) -> AppResult<Vec<i32>> {
    let metadata = worker
        .fetch_metadata(Some(topic), METADATA_TIMEOUT)
        .map_err(AppError::from)?;
    let found = metadata.topics().iter().find(|item| item.name() == topic);
    match found {
        Some(item) if !item.partitions().is_empty() => {
            Ok(item.partitions().iter().map(|part| part.id()).collect())
        }
        // 主题存在但分区为空：可能是创建中的瞬态，给一条能看懂的话。
        Some(_) => Err(AppError::Broker(format!("主题 {topic} 暂时没有可用的分区"))),
        None => Err(AppError::Invalid(format!("主题 {topic} 不存在"))),
    }
}

/// 读一轮水位。单分区失败按「缺失」处理，而不是整轮报错：
/// 权限受限的账号能看到元数据、读不到部分分区的水位，此时其余分区
/// 的速率仍然成立 —— 只是少几个分区，不需要整页作废。
fn collect(worker: &BaseConsumer, topic: &str, partitions: &[i32]) -> AppResult<TopicSample> {
    let mut marks: Vec<PartitionWatermark> = Vec::with_capacity(partitions.len());
    let deadline = std::time::Instant::now() + SAMPLE_TIMEOUT;

    for &partition in partitions {
        if std::time::Instant::now() > deadline {
            return Err(AppError::Broker(format!(
                "采样超时：{} 秒内未能读完 {} 的水位，请减少主题分区数或稍后重试",
                SAMPLE_TIMEOUT.as_secs(),
                topic
            )));
        }
        if let Ok((low, high)) = worker.fetch_watermarks(topic, partition, WATERMARK_TIMEOUT) {
            marks.push(PartitionWatermark::new(partition, low, high));
        }
    }

    if marks.is_empty() {
        return Err(AppError::Broker(format!(
            "读不到 {topic} 的任何分区水位，请检查账号是否有读取权限"
        )));
    }
    Ok(TopicSample::new(now_ms(), marks))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_defaults_and_clamps() {
        assert_eq!(
            normalize_window(None).expect("默认值可用"),
            DEFAULT_WINDOW_MS
        );
        // 超过一分钟不报错，夹到一分钟：用户只是想多看一会儿。
        assert_eq!(
            normalize_window(Some(10 * 60_000)).expect("上限应当放行"),
            MAX_WINDOW_MS
        );
    }

    #[test]
    fn too_short_window_is_rejected_with_reason() {
        let error = normalize_window(Some(MIN_WINDOW_MS - 1)).unwrap_err();
        assert!(error.to_string().contains("采样间隔"), "{error}");
    }

    #[test]
    fn boundary_windows_are_accepted() {
        assert_eq!(
            normalize_window(Some(MIN_WINDOW_MS)).expect("下限本身可用"),
            MIN_WINDOW_MS
        );
        assert_eq!(
            normalize_window(Some(MAX_WINDOW_MS)).expect("上限本身可用"),
            MAX_WINDOW_MS
        );
    }
}
