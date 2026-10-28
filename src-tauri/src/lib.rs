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
            commands::cluster::load_cluster,
            commands::cluster::load_runtime,
            commands::cluster::load_connection_channels,
            commands::cluster::load_queue_placements,
            commands::cluster::load_node_stats,
            commands::cluster::close_amqp_connection,
            commands::cluster::close_amqp_channel,
            commands::reset::preview_group_reset,
            commands::reset::commit_group_reset,
            commands::reset::reset_phases,
            commands::consumer::list_consumer_groups,
            commands::consumer::get_consumer_group,
            commands::consumer::sample_consumer_lag_trend,
            commands::consumer::sample_consumer_block,
            commands::consumer::preflight_group_removal,
            commands::consumer::delete_consumer_groups,
            commands::message::list_topics,
            commands::topic::get_topic,
            commands::topic::get_topic_capabilities,
            commands::topic::create_topic,
            commands::topic::expand_topic,
            commands::topic::delete_topic,
            commands::topic::preview_topic_configs,
            commands::topic::update_topic_configs,
            commands::topic::analyze_partition_hotspots,
            commands::topic::sample_topic_throughput,
            commands::topic::preview_topic_purge,
            commands::topic::purge_topic,
            commands::topic::export_reassignment_plan,
            commands::topic::check_reassignment_plan,
            commands::topic::get_migration_progress,
            commands::topic::build_migration_runbook,
            commands::topic::parse_migration_verify,
            commands::acl::describe_acls,
            commands::acl::preview_acl_create,
            commands::acl::commit_acl_create,
            commands::acl::preview_acl_delete,
            commands::acl::commit_acl_delete,
            commands::quota::describe_client_quotas,
            commands::quota::describe_user_scram_credentials,
            commands::admin::load_admin,
            commands::admin::save_vhost,
            commands::admin::delete_vhost,
            commands::admin::save_user,
            commands::admin::delete_user,
            commands::admin::save_permission,
            commands::admin::delete_permission,
            commands::policy::list_policies,
            commands::policy::get_policy,
            commands::policy::preview_policy,
            commands::policy::save_policy,
            commands::policy::delete_policy,
            commands::parameter::list_parameters,
            commands::parameter::review_parameter_spec,
            commands::parameter::save_parameter,
            commands::parameter::delete_parameter,
            commands::shovel::list_shovels,
            commands::message::list_queues,
            commands::message::load_topology,
            commands::message::load_topology_insight,
            commands::message::load_topology_graph,
            commands::message::load_consumer_graph,
            commands::message::get_queue,
            commands::message::list_queue_consumers,
            commands::message::list_consumer_ownership,
            commands::message::purge_queue,
            commands::message::delete_queue,
            commands::message::disconnect_consumer,
            commands::message::create_exchange,
            commands::message::delete_exchange,
            commands::message::create_binding,
            commands::message::delete_binding,
            commands::message::list_orphan_candidates,
            commands::message::list_orphan_topics,
            commands::message::list_messages,
            commands::message::locate_messages,
            commands::message::get_message,
            commands::message::get_disposal_capabilities,
            commands::message::redeliver_message,
            commands::message::dead_letter_message,
            commands::message::batch_dispose_messages,
            commands::message::retry_stranded_messages,
            commands::message::resend_message,
            commands::message::send_message,
            commands::message::preview_send,
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
