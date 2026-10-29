//! 命令层日志包装。
//!
//! 「哪个命令报了什么错、耗时多久」是排查时最先要的两条信息，但每条命令里手写一遍
//! 既啰嗦又会写漏。这里提供一个统一的 `traced` 把手：成功记 debug(耗时)，
//! 失败记 error(耗时 + 错误)，调用方只关心业务本身。

use std::{
    fmt::Debug,
    future::Future,
    time::{Duration, Instant},
};

use crate::error::AppError;

/// 执行一条命令体并记录结果。
///
/// `payload` 是需要一起落进日志的参数（已脱敏），只在失败或 debug 级别时格式化。
pub async fn traced<T, F>(
    command: &'static str,
    payload: impl FnOnce() -> String,
    body: F,
) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    let started = Instant::now();
    match body.await {
        Ok(value) => {
            log::debug!(
                target: "mqtui::command",
                "{command} 完成，耗时 {}，参数：{}",
                took(started.elapsed()),
                payload()
            );
            Ok(value)
        }
        Err(error) => {
            log::error!(
                target: "mqtui::command",
                "{command} 失败 [{}]，耗时 {}，参数：{}，错误：{error}",
                kind(&error),
                took(started.elapsed()),
                payload()
            );
            Err(error)
        }
    }
}

/// 执行一条同步命令体并记录结果。
pub fn traced_sync<T>(
    command: &'static str,
    payload: impl FnOnce() -> String,
    body: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let started = Instant::now();
    match body() {
        Ok(value) => {
            log::debug!(
                target: "mqtui::command",
                "{command} 完成，耗时 {}，参数：{}",
                took(started.elapsed()),
                payload()
            );
            Ok(value)
        }
        Err(error) => {
            log::error!(
                target: "mqtui::command",
                "{command} 失败 [{}]，耗时 {}，参数：{}，错误：{error}",
                kind(&error),
                took(started.elapsed()),
                payload()
            );
            Err(error)
        }
    }
}

/// 错误种类的稳定短名，和前端 `AppErrorKind` 一致。
fn kind(error: &AppError) -> &'static str {
    match error {
        AppError::Invalid(_) => "invalid",
        AppError::Connect(_) => "connect",
        AppError::Broker(_) => "broker",
        AppError::NotFound(_) => "not_found",
        AppError::Unsupported(_) => "unsupported",
        AppError::Internal(_) => "internal",
    }
}

fn took(duration: Duration) -> String {
    let millis = duration.as_millis();
    if millis < 1_000 {
        format!("{millis}ms")
    } else {
        format!("{:.2}s", duration.as_secs_f64())
    }
}

/// 把参数压成一行短串：调试时看的是「带没带对参数」，不是看 JSON 全貌。
pub fn brief(value: impl Debug) -> String {
    let text = format!("{value:?}");
    const LIMIT: usize = 320;
    if text.chars().count() <= LIMIT {
        return text;
    }
    let head: String = text.chars().take(LIMIT).collect();
    format!("{head}…（共 {} 字符）", text.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn 成功时透传返回值与参数_debug() {
        let value = traced("demo", || "id=1".to_owned(), async { Ok(7u8) }).await;
        assert_eq!(value.ok(), Some(7));
    }

    #[tokio::test]
    async fn 失败时原样返回错误() {
        let error = traced::<(), _>("demo", || "-".to_owned(), async {
            Err(AppError::NotFound("连接 x".to_owned()))
        })
        .await
        .expect_err("应保留错误");
        assert_eq!(kind(&error), "not_found");
        assert_eq!(error.to_string(), "资源不存在: 连接 x");
    }

    #[test]
    fn brief_只截断超长参数并标注长度() {
        let short = brief(vec![1, 2, 3]);
        assert_eq!(short, "[1, 2, 3]");

        let long = brief("x".repeat(500));
        assert!(long.ends_with("（共 502 字符）"), "{long}");
        assert_eq!(long.chars().filter(|c| *c == 'x').count(), 320);
    }

    #[test]
    fn took_按毫秒与秒分档() {
        assert_eq!(took(Duration::from_micros(900)), "0ms");
        assert_eq!(took(Duration::from_millis(1500)), "1.50s");
    }
}
