//! 消费组位点重置的命令。
//!
//! 拆成「预览」与「提交」两个命令，而不是一个带 `dryRun` 参数的命令：
//! 两个动作的前置条件不同 —— 预览只读，谁都能跑；提交要求计划可执行、
//! 且必须把**用户确认过的那份计划**原样带回来。
//!
//! 这一点很关键：如果提交时只传「组 + 主题 + 目标」，服务端会按当下的位点重新算一遍。
//! 从预览到点击确认之间，消费者可能已经推进了几千条 —— 用户确认的计划和实际执行的计划
//! 就不是同一件事了。所以提交带的是预览产出的完整 `ResetPlan`。

use tauri::State;

use crate::domain::{ConnectionId, ResetPlan, ResetTarget, reset_phases as build_phases};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::trace;

/// 预览重置计划。
#[tauri::command]
pub async fn preview_group_reset(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
    topic: String,
    target: ResetTarget,
    offsets: Option<Vec<(i32, i64)>>,
    timestamp: Option<i64>,
) -> AppResult<ResetPlan> {
    let connection = state.connections.get(&id).await?;
    let client = connection.as_kafka()?;
    let offsets = offsets.unwrap_or_default();

    // 「组里还有没有活跃成员」直接决定位点改动会不会被覆盖，
    // 所以在预览阶段就查清楚，写进计划的注意事项里。
    let has_active_members = active_members(&state, &id, &group).await;

    client
        .preview_reset(
            &group,
            &topic,
            target,
            &offsets,
            timestamp,
            has_active_members,
        )
        .await
}

/// 提交重置计划。返回实际提交的分区数。
#[tauri::command]
pub async fn commit_group_reset(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
    topic: String,
    plan: ResetPlan,
) -> AppResult<CommitOutcome> {
    // 摘要先拼好：payload 闭包只借用，命令体要拿走 group / topic / plan 的所有权。
    let payload = format!(
        "id={id}, group={group}, topic={topic}, plan={}",
        trace::brief(&plan)
    );
    crate::commands::trace::traced("commit_group_reset", || payload, async {
        let connection = state.connections.get(&id).await?;
        let client = connection.as_kafka()?;

        // 提交前再确认一次「计划可执行」。前端也会拦，但命令是公开入口，
        // 不能假设所有调用方都先跑了预览。
        if !plan.is_executable() {
            let reason = plan
                .blockers
                .first()
                .cloned()
                .unwrap_or_else(|| "计划没有实际改动，无需提交".to_owned());
            return Err(AppError::Invalid(reason));
        }

        let changed = plan.changes().len();
        let committed = client.commit_reset(&group, &topic, &plan).await?;
        Ok(CommitOutcome {
            group,
            topic,
            replay: plan.replay,
            skip: plan.skip,
            requested: changed,
            committed,
        })
    })
    .await
}

/// 提交结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub group: String,
    pub topic: String,
    /// 会被重放的消息数。
    pub replay: i64,
    /// 会被跳过的消息数。
    pub skip: i64,
    /// 计划里需要改动的分区数。
    pub requested: usize,
    /// 实际提交的分区数。与 `requested` 不等时说明中途有分区失效。
    pub committed: usize,
}

/// 执行顺序说明，前端直接渲染。
#[tauri::command]
pub async fn reset_phases(
    state: State<'_, AppState>,
    id: ConnectionId,
    group: String,
) -> AppResult<Vec<crate::domain::ResetPhase>> {
    let has_active_members = active_members(&state, &id, &group).await;
    Ok(build_phases(&group, has_active_members))
}

/// 判断消费组当前是否有活跃成员。
///
/// 查不到就当作「有」—— 保守方向：多一句提醒，比让用户以为可以随便改要好。
async fn active_members(state: &State<'_, AppState>, id: &ConnectionId, group: &str) -> bool {
    let Ok(connection) = state.connections.get(id).await else {
        return true;
    };
    let Ok(client) = connection.as_kafka() else {
        return true;
    };
    match client.consumer_group_members(group).await {
        Ok(members) => members > 0,
        Err(_) => true,
    }
}
