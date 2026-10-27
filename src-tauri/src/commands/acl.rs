//! Kafka ACL 命令：只读。
//!
//! 只有一个命令，因为只有一个失败面：读不到要么是版本、要么是权限，
//! 两者都在返回的快照里各自解释，不需要拆成两条路径互相拖累。
//!
//! 不提供写入。`CreateAcls` / `DeleteAcls` 在 librdkafka 里是有的，
//! 但 ACL 写错是授权事故：多一条「谁能进来」，少一条「谁掉线」。
//! 面板要做写入，先得有「与现有规则比对、说清新增/覆盖/冲突」的那一步。

use tauri::State;

use crate::domain::{AclFilter, AclSnapshot, ConnectionId};
use crate::error::AppResult;
use crate::message::kafka::acl;
use crate::state::AppState;

/// 读取 ACL 规则。过滤器为空时返回全部规则。
#[tauri::command]
pub async fn describe_acls(
    state: State<'_, AppState>,
    id: ConnectionId,
    filter: Option<AclFilter>,
) -> AppResult<AclSnapshot> {
    let connection = state.connections.get(&id).await?;
    acl::acls(connection.as_kafka()?, filter.unwrap_or_default()).await
}
