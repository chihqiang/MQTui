//! 日志基础设施：一处配置，控制台、日志文件、前端三边同时生效。
//!
//! 默认级别来自 `MQTUI_LOG`（或 `RUST_LOG`），本项目自己的日志在 release 下也至少是
//! `info` —— 出问题时用户手上的 release 构建里必须有线索，而不是只有一句「失败了」。

/// 默认过滤器：自身 crate 用 info（想看细节可临时调到 debug），驱动类第三方库压到 warn。
pub fn default_filter() -> String {
    // 环境变量优先：开着应用现场查问题时，改 `MQTUI_LOG` 比重编快得多。
    if let Ok(filter) = std::env::var("MQTUI_LOG").or_else(|_| std::env::var("RUST_LOG"))
        && !filter.trim().is_empty()
    {
        return filter;
    }

    // rdkafka / lapin 在 debug 级别会按心跳粒度刷屏，把真正想看的淹掉。
    "mqtui_lib=info,tauri=info,warn,rdkafka=warn,lapin=warn,reqwest=warn".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认过滤器把驱动库压到_warn() {
        let filter = default_filter();
        assert!(filter.contains("mqtui_lib=info"), "{filter}");
        assert!(filter.contains("rdkafka=warn"), "{filter}");
    }
}

/// 组装日志插件。
///
/// - 控制台：只放本项目和插件的 debug —— `npm run tauri dev` 时能直接看到命令进出。
/// - 文件：记 info 及以上，落在系统日志目录，崩溃后还能翻。
/// - Webview：把后端日志推给前端控制台，开 DevTools 时前后端时间线能对齐。
#[cfg(feature = "desktop")]
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

    /// 日志文件按 5 MB 滚动，最多保留 5 个历史文件。
    const MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;
    const MAX_LOG_FILES: usize = 5;
    /// 日志文件名（不含扩展名），落在系统日志目录下的应用目录里。
    const LOG_FILE_NAME: &str = "mqtui";

    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout).filter(|metadata| {
                metadata.level() <= log::Level::Debug || metadata.target().starts_with("mqtui")
            }),
            Target::new(TargetKind::LogDir {
                file_name: Some(LOG_FILE_NAME.to_owned()),
            })
            .filter(|metadata| metadata.level() <= log::Level::Info),
            Target::new(TargetKind::Webview),
        ])
        .level(log::LevelFilter::Info)
        .max_file_size(MAX_FILE_SIZE)
        .rotation_strategy(RotationStrategy::KeepSome(MAX_LOG_FILES))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .build()
}
