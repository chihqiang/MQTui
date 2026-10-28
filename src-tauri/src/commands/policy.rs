//! RabbitMQ 策略（policy）命令。
//!
//! 与其它命令同构：解析参数 → 取连接 → 交给 `broker` 层 → 转换错误。
//! 校验与后果说明放在 `domain::policy`，这里只做「拉全量 → 本地校验 → 提交」
//! 这一段编排，因为它需要同时看到策略本身和同 vhost 的其它策略（优先级冲突）。

use tauri::State;

use crate::domain::{
    ConnectionId, ImpactEstimate, PolicyInfo, PolicyRemoval, PolicySnapshot, PolicySpec,
    PriorityConflict, estimate_impact, removal_caveats, suppressed_by,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 提交前的完整预览：影响面 + 优先级冲突。
///
/// 单独成结构而不是让前端自己估：影响面要拿队列 / 交换机名单，
/// 冲突要拿全部策略，都是后端已经有的数据。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPreview {
    /// 影响面估算（启发式，`exact` 恒为 false）。
    pub impact: ImpactEstimate,
    /// 会被哪些既有策略压制。
    pub conflicts: Vec<PriorityConflict>,
    /// 策略语义本身的注意事项，确认框里逐条展示。
    pub caveats: Vec<String>,
    /// 模式本身读不准时的说明（字符类 / 转义 / 无可比字面量）。
    ///
    /// 单独放一个字段而不是塞进 `caveats`：它解释的是「上面那个数字有多可信」，
    /// 和「策略语义上有什么坑」是两件事，混在一起会让人跳过它。
    pub pattern_note: Option<String>,
}

/// 删除前要看的后果。只读，不写任何东西。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRemovalPreview {
    /// 这条策略当前的定义项里，删掉后会「退回默认」的那些。
    pub caveats: Vec<String>,
    /// 同范围内、优先级更低因而长期没生效的策略。
    ///
    /// 删掉这条之后它们会**接替生效** —— 这通常不是删策略的人预期的结果：
    /// 他以为「去掉限制」，实际是「换成了另一条更松或更紧的规则」。
    pub successors: Vec<String>,
}

/// 读出全部策略（含操作员策略）。
#[tauri::command]
pub async fn list_policies(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<PolicySnapshot> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.policies().await
}

/// 预览策略改动：影响面、优先级冲突、注意事项。不写任何东西。
#[tauri::command]
pub async fn preview_policy(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: PolicySpec,
) -> AppResult<PolicyPreview> {
    spec.validate().map_err(AppError::Invalid)?;

    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;
    let snapshot = client.policies().await?;
    let topology = client.topology().await?;

    let queue_names: Vec<String> = topology
        .queues
        .iter()
        .map(|item| item.name.clone())
        .collect();
    let exchange_names: Vec<String> = topology
        .exchanges
        .iter()
        .map(|item| item.name.clone())
        .collect();

    let caveats = spec.caveats();
    let impact = estimate_impact(&spec.pattern, spec.apply_to, &queue_names, &exchange_names);
    Ok(PolicyPreview {
        impact,
        conflicts: suppressed_by(&spec, &snapshot.policies),
        caveats,
        pattern_note: impact.confidence.note().map(str::to_owned),
    })
}

/// 删除策略前的后果预检。只读。
#[tauri::command]
pub async fn preview_policy_removal(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<PolicyRemovalPreview> {
    let connection = state.connections.get(&id).await?;
    let snapshot = connection.as_rabbitmq()?.policies().await?;

    // 找不到就直说：删一条不存在的策略，服务端也会返回 404，
    // 但那时用户已经确认过一次「删除」了。
    let policy = snapshot
        .policies
        .iter()
        .find(|item| item.name == name)
        .ok_or_else(|| AppError::NotFound(format!("策略 {name} 不存在")))?;

    // 接替者必须同 scope 才可能接手：`apply-to: queues` 的策略不接管交换机。
    let successors = snapshot
        .policies
        .iter()
        .filter(|other| {
            other.name != policy.name
                && other.vhost == policy.vhost
                && other.apply_to == policy.apply_to
                && other.priority <= policy.priority
        })
        .map(|other| {
            format!(
                "`{}`（优先级 {}，模式 `{}`）会在这条删除后接手同一范围",
                other.name, other.priority, other.pattern
            )
        })
        .collect();

    Ok(PolicyRemovalPreview {
        caveats: removal_caveats(&policy.definition),
        successors,
    })
}

/// 提交策略。`originalName` 非空表示重命名：先写新策略再删旧的。
#[tauri::command]
pub async fn save_policy(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: PolicySpec,
    original_name: Option<String>,
) -> AppResult<PolicySnapshot> {
    spec.validate().map_err(AppError::Invalid)?;

    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;

    // 重命名不是原子操作：管理 API 没有 rename。顺序必须是「先建新的、再删旧的」，
    // 反过来会有一段窗口期完全没有策略生效，队列会退回没有 TTL / 长度上限的状态。
    client.put_policy(&spec, &spec.name).await?;

    if let Some(original) = original_name.as_deref()
        && !original.trim().is_empty()
        && original != spec.name
    {
        client.delete_policy(original).await?;
    }

    client.policies().await
}

/// 删除策略。策略删除只是停止下发，不动已有消息，因此没有额外守卫参数。
#[tauri::command]
pub async fn delete_policy(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<PolicySnapshot> {
    if !PolicyRemoval::evaluate(&name).is_allowed() {
        return Err(AppError::Invalid(
            PolicyRemoval::evaluate(&name)
                .reason()
                .unwrap_or("策略名称为空")
                .to_owned(),
        ));
    }

    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;
    client.delete_policy(&name).await?;
    client.policies().await
}

/// 单条策略详情。前端从快照里取即可，这里只给「按名字定位」留一个入口。
#[tauri::command]
pub async fn get_policy(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<PolicyInfo> {
    let connection = state.connections.get(&id).await?;
    let snapshot = connection.as_rabbitmq()?.policies().await?;
    snapshot
        .policies
        .into_iter()
        .find(|policy| policy.name == name)
        .ok_or_else(|| AppError::NotFound(format!("策略 {name} 不存在")))
}
