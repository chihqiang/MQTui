//! MQTui：面向 Kafka / RabbitMQ 的跨平台桌面管理面板。
//!
//! 分层约定：
//! - `domain`：与具体消息中间件无关的领域模型（连接配置、消息、分页等）。
//! - `broker`：建立连接，按中间件拆分子模块。
//! - `message`：消息查询与发送，按中间件拆分子模块。
//! - `commands`：Tauri 命令层，只做参数/错误转换，不写业务逻辑。
//! - `state`：应用级状态（连接池、后台任务句柄）。

pub mod broker;
#[cfg(feature = "desktop")]
pub mod commands;
pub mod domain;
pub mod error;
pub mod message;
#[cfg(feature = "desktop")]
pub mod state;

/// 启动 Tauri 应用。
#[cfg(feature = "desktop")]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::broker::list_plugin_kinds,
            commands::broker::open_connection,
            commands::broker::list_connections,
            commands::broker::close_connection,
            commands::broker::load_overview,
            commands::broker::check_health,
            commands::consumer::list_consumer_groups,
            commands::consumer::get_consumer_group,
            commands::message::list_topics,
            commands::message::list_queues,
            commands::message::load_topology,
            commands::message::get_queue,
            commands::message::purge_queue,
            commands::message::delete_queue,
            commands::message::create_exchange,
            commands::message::delete_exchange,
            commands::message::create_binding,
            commands::message::delete_binding,
            commands::message::list_orphan_candidates,
            commands::message::list_orphan_topics,
            commands::message::list_messages,
            commands::message::get_message,
            commands::message::send_message,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

/// 初始化日志。默认只输出 warn 及以上，可用 `RUST_LOG` 覆盖。
#[cfg(feature = "desktop")]
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("mqtui_lib=info,warn"));

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();
}
