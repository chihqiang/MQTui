//! 客户端配额与 SASL/SCRAM 凭据的读取。
//!
//! ## 为什么这里要碰 FFI
//!
//! librdkafka 2.12 的 C 头文件导出了 `rd_kafka_DescribeUserScramCredentials`，
//! 但 `rdkafka` crate 的 `AdminClient` 没有把它包出来（只包了 topic 与 group 那几组）。
//! 读操作、无状态、一次请求一个事件，包一层是可控的；写操作就不一样了 ——
//! 那要保证「失败时不会留下半个凭据」，不值得在这里手写。
//!
//! ## 配额为什么读不到
//!
//! 同一个头文件里**没有** `rd_kafka_DescribeClientQuotas` 的导出符号（协议版本表里
//! 有这个名字，但那是内部表，不是 API）。`KafkaClient` 能拿到的只有一个不透明的
//! `*mut RDKafka`，硬发协议请求等于绕过 librdkafka 自己实现一遍版本协商与重试。
//! 所以这一屏返回「读不到 + 为什么」，而不是一个空列表 ——
//! 空列表会被读成「没有任何配额」。

use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::time::Duration;

use rdkafka::bindings::{self, rd_kafka_resp_err_t};

use crate::domain::{KeyValue, QuotaSnapshot, ScramCredential, ScramMechanism, ScramUser};
use crate::error::{AppError, AppResult};

use super::KafkaClient;

/// 管理请求的超时。
const ADMIN_TIMEOUT: Duration = Duration::from_secs(15);

/// 读取全部用户的 SCRAM 凭据。
///
/// broker 低于 2.7.0 时 `DescribeUserScramCredentials` 不存在，返回
/// `AppError::Unsupported`：那是「问不了」，不是「出错了」，界面要分开说。
pub async fn describe_scram(client: &KafkaClient) -> AppResult<Vec<ScramUser>> {
    let worker = client.clone_handle()?;
    tokio::task::spawn_blocking(move || read_scram(&worker))
        .await
        .map_err(|error| AppError::Internal(format!("SCRAM 凭据任务失败: {error}")))?
}

/// 在阻塞线程里发一次请求并解析。
fn read_scram(client: &KafkaClient) -> AppResult<Vec<ScramUser>> {
    let admin = client.admin()?;
    let rk = admin.inner().native_ptr();

    let queue = unsafe { bindings::rd_kafka_queue_new(rk) };
    if queue.is_null() {
        return Err(AppError::Internal("创建 Kafka 结果队列失败".to_owned()));
    }
    // 队列要跟着这次调用一起消失，用守卫保证异常路径上也销毁。
    struct QueueGuard(*mut bindings::rd_kafka_queue_t);
    impl Drop for QueueGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { bindings::rd_kafka_queue_destroy(self.0) };
            }
        }
    }
    let guard = QueueGuard(queue);

    // options 传 NULL 即默认；用户数组传 NULL 表示「全部用户」。
    unsafe {
        bindings::rd_kafka_DescribeUserScramCredentials(
            rk,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            guard.0,
        );
    }

    // 事件归调用方，解析完必须销毁 —— 所以拿到它之后第一件事就是交给守卫，
    // 而不是等解析完再交：中间任何一个 `return Err` 都会把事件漏在堆上。
    let owned = poll_event(guard.0, "SCRAM 凭据")?;
    let event = owned.0;

    let error = unsafe { bindings::rd_kafka_event_error(event) };
    if error != rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
        let message = unsafe { error_string(bindings::rd_kafka_event_error_string(event)) }
            .unwrap_or_else(|| format!("{error:?}"));
        return if is_unsupported(&message) {
            Err(AppError::Unsupported(format!(
                "broker 不支持 DescribeUserScramCredentials（需要 2.7.0 以上）：{message}"
            )))
        } else {
            Err(AppError::Broker(format!("读取 SCRAM 凭据失败: {message}")))
        };
    }

    Ok(unsafe { collect_users(owned.0) })
}

/// 轮询结果事件。超时不说「成功」，也不说「失败」—— 它只说明「不知道」。
///
/// 返回值**已经**是守卫：调用方拿到它的那一刻起，任何一条退出路径都会销毁事件。
fn poll_event(guard: *mut bindings::rd_kafka_queue_t, action: &str) -> AppResult<EventGuard> {
    let event = unsafe { bindings::rd_kafka_queue_poll(guard, ADMIN_TIMEOUT.as_millis() as c_int) };
    if event.is_null() {
        return Err(AppError::Broker(format!(
            "等待{action}结果超时（{} 秒）",
            ADMIN_TIMEOUT.as_secs()
        )));
    }
    Ok(EventGuard(event))
}

/// 事件指针的销毁守卫。
struct EventGuard(*mut bindings::rd_kafka_event_t);

impl Drop for EventGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { bindings::rd_kafka_event_destroy(self.0) };
        }
    }
}

/// 从结果事件里读出每个用户的凭据。
///
/// 单个用户失败不影响整张表：把它自己那一行标出来，其余照常展示。
/// 整表作废会让一个小权限问题看起来像「集群没有 SCRAM」。
///
/// # Safety
///
/// `event` 必须是 `DescribeUserScramCredentials` 产生且仍然有效的事件。
unsafe fn collect_users(event: *mut bindings::rd_kafka_event_t) -> Vec<ScramUser> {
    let descriptions =
        unsafe { bindings::rd_kafka_event_DescribeUserScramCredentials_result(event) };
    if descriptions.is_null() {
        return Vec::new();
    }

    let mut count: usize = 0;
    let array = unsafe {
        bindings::rd_kafka_DescribeUserScramCredentials_result_descriptions(
            descriptions,
            &mut count,
        )
    };
    if array.is_null() {
        return Vec::new();
    }

    let mut users = Vec::with_capacity(count);
    for index in 0..count {
        let description = unsafe { *array.add(index) };
        if description.is_null() {
            continue;
        }

        let user = unsafe {
            error_string(bindings::rd_kafka_UserScramCredentialsDescription_user(
                description,
            ))
        }
        .unwrap_or_default();

        let error = unsafe {
            let raw = bindings::rd_kafka_UserScramCredentialsDescription_error(description);
            kafka_error_text(raw)
        };

        let credentials = if error.is_some() {
            Vec::new()
        } else {
            unsafe { collect_credentials(description) }
        };

        users.push(ScramUser {
            user,
            credentials,
            error,
        });
    }
    users
}

/// # Safety
///
/// `description` 必须是有效的 `rd_kafka_UserScramCredentialsDescription_t`。
unsafe fn collect_credentials(
    description: *const bindings::rd_kafka_UserScramCredentialsDescription_t,
) -> Vec<ScramCredential> {
    let count = unsafe {
        bindings::rd_kafka_UserScramCredentialsDescription_scramcredentialinfo_count(description)
    };
    let mut credentials = Vec::with_capacity(count);
    for index in 0..count {
        let info = unsafe {
            bindings::rd_kafka_UserScramCredentialsDescription_scramcredentialinfo(
                description,
                index,
            )
        };
        if info.is_null() {
            continue;
        }
        let mechanism = unsafe { bindings::rd_kafka_ScramCredentialInfo_mechanism(info) } as c_int;
        // UNKNOWN = 0：把它显示成 SHA-256 是编造，直接跳过。
        let mechanism = match mechanism {
            1 => ScramMechanism::Sha256,
            2 => ScramMechanism::Sha512,
            _ => continue,
        };
        let iterations = unsafe { bindings::rd_kafka_ScramCredentialInfo_iterations(info) } as i32;
        credentials.push(ScramCredential {
            mechanism,
            iterations,
        });
    }
    credentials
}

/// 把 `rd_kafka_error_t*` 读成人话。空指针与 `NO_ERROR` 都算没有错误。
///
/// # Safety
///
/// `error` 要么为空，要么是有效的 `rd_kafka_error_t`。
unsafe fn kafka_error_text(error: *const bindings::rd_kafka_error_t) -> Option<String> {
    if error.is_null() {
        return None;
    }
    let code = unsafe { bindings::rd_kafka_error_code(error) };
    if code == rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
        return None;
    }
    Some(
        unsafe { error_string(bindings::rd_kafka_error_string(error)) }
            .unwrap_or_else(|| format!("{code:?}")),
    )
}

/// # Safety
///
/// `raw` 要么为空，要么是有效的 NUL 结尾字符串。
unsafe fn error_string(raw: *const c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// 判断错误串是不是「broker 不认识这个 API」。
///
/// 按关键词而不是错误码：拿到这里时已经是字符串，码在翻译过程中丢了。
fn is_unsupported(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("unsupported") || lowered.contains("not supported")
}

/// 客户端配额快照。
///
/// 读不到配额不是「零配额」：返回的 `notes` 会说明原因，界面据此显示一行解释
/// 而不是一张空表。抛错的话那一屏只剩红字，用户分不清是集群没配额还是面板没本事。
pub fn describe_quota() -> QuotaSnapshot {
    crate::domain::assemble_quota(Vec::new(), None)
}

/// 从 broker 配置里捡出与配额相关的线索。
///
/// 配额列表读不到，但 broker 级默认值（`quota.producer.default` 等）在
/// `describe_configs(Broker)` 里拿得到 —— 那是「没配配额时用多少」的答案，
/// 比一张空表有用。失败时静默跳过，不干扰主结论。
pub async fn default_quota_hints(client: &KafkaClient) -> Vec<KeyValue> {
    let Ok(admin) = client.admin() else {
        return Vec::new();
    };
    let Ok(results) = admin
        .describe_configs(
            &[rdkafka::admin::ResourceSpecifier::Broker(-1)],
            &rdkafka::admin::AdminOptions::new(),
        )
        .await
    else {
        return Vec::new();
    };

    results
        .into_iter()
        .filter_map(|result| result.ok())
        .flat_map(|config| config.entries)
        .filter(|entry| {
            matches!(
                entry.name.as_str(),
                "quota.producer.default"
                    | "quota.consumer.default"
                    | "quota.window.size.seconds"
                    | "quota.window.num"
            )
        })
        .map(|entry| KeyValue::new(entry.name, entry.value.unwrap_or_default()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_messages_are_recognised() {
        assert!(is_unsupported(
            "Unsupported version of API DescribeUserScramCredentials"
        ));
        assert!(is_unsupported("BROKER: UNSUPPORTED_VERSION"));
        assert!(is_unsupported(
            "This request is not supported by this broker"
        ));
        assert!(!is_unsupported("Cluster authorization failed"));
    }

    #[test]
    fn quota_snapshot_says_why_it_is_empty() {
        let snapshot = describe_quota();
        assert!(snapshot.is_empty());
        // 空表必须自带解释，否则会被读成「没有任何配额，所以没人被限」。
        assert!(
            snapshot
                .notes
                .iter()
                .any(|note| note.contains("kafka-configs.sh"))
        );
    }

    #[test]
    fn null_error_pointer_is_not_an_error() {
        // 空指针是「这个用户没问题」的正常路径，不是错误。
        assert!(unsafe { kafka_error_text(std::ptr::null()) }.is_none());
    }
}
