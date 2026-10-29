//! Kafka ACL 命令：先预演，再提交。
//!
//! 每一条写路径都拆成两个命令（`preview_*` / `commit_*`），不是为了让前端多按一次，
//! 而是因为 ACL 写错属于**授权事故**：多一条是「谁能进来」，少一条是「谁掉线」。
//! 拆开之后，用户看到的是「这次提交会新增 2 条、其中 1 条与现有规则冲突」，
//! 而不是一个点下去才知道后果的按钮。
//!
//! 提交不复用预演结果：确认框可能开着几十秒，期间别人可能刚改过 ACL。

use tauri::State;

use crate::domain::{AclChangePlan, AclFilter, AclSnapshot, AclWriteRequest, ConnectionId};
use crate::error::AppResult;
use crate::message::kafka::acl;
use crate::state::AppState;

use super::trace;

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

/// 预演新增：说清这次提交会新增什么、和谁冲突、会不会把自己锁在外面。
#[tauri::command]
pub async fn preview_acl_create(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: AclWriteRequest,
) -> AppResult<AclChangePlan> {
    let connection = state.connections.get(&id).await?;
    acl::preview_create(connection.as_kafka()?, request).await
}

/// 提交新增。`request.confirm` 必须是主体名，否则整单拒绝。
#[tauri::command]
pub async fn commit_acl_create(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: AclWriteRequest,
) -> AppResult<acl::AclWriteReport> {
    let desc = trace::brief(&request);
    crate::commands::trace::traced(
        "commit_acl_create",
        || format!("id={id}, request={desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            acl::commit_create(connection.as_kafka()?, request).await
        },
    )
    .await
}

/// 预演删除：只有和现有规则逐字相等的条目才算数。
#[tauri::command]
pub async fn preview_acl_delete(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: AclWriteRequest,
) -> AppResult<AclChangePlan> {
    let connection = state.connections.get(&id).await?;
    acl::preview_delete(connection.as_kafka()?, request).await
}

/// 提交删除。
#[tauri::command]
pub async fn commit_acl_delete(
    state: State<'_, AppState>,
    id: ConnectionId,
    request: AclWriteRequest,
) -> AppResult<acl::AclWriteReport> {
    let desc = trace::brief(&request);
    crate::commands::trace::traced(
        "commit_acl_delete",
        || format!("id={id}, request={desc}"),
        async {
            let connection = state.connections.get(&id).await?;
            acl::commit_delete(connection.as_kafka()?, request).await
        },
    )
    .await
}
