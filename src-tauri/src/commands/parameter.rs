//! RabbitMQ 参数（parameter）命令。
//!
//! 与策略命令同构：拉全量 → 本地校验 → 提交。区别在于参数值是一整块 JSON，
//! 校验只能交给 `domain::parameter`，这里不重复解读字段。

use tauri::State;

use crate::domain::{
    ConnectionId, ParameterComponent, ParameterRemoval, ParameterReview, ParameterSnapshot,
    ParameterSpec, review_parameter,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 读出全部参数（按组件分类，某一类失败只影响它自己）。
#[tauri::command]
pub async fn list_parameters(
    state: State<'_, AppState>,
    id: ConnectionId,
) -> AppResult<ParameterSnapshot> {
    let connection = state.connections.get(&id).await?;
    connection.as_rabbitmq()?.parameters().await
}

/// 校验参数：JSON 语法、组件形状、vhost 语义、以及要提醒的后果。不写任何东西。
#[tauri::command]
pub fn review_parameter_spec(spec: ParameterSpec) -> ParameterReview {
    review_parameter(&spec)
}

/// 提交参数。`originalName` 非空表示重命名：先写新的再删旧的。
///
/// 参数没有 rename 接口，顺序反过来会有一段窗口期「这条联邦根本不存在」，
/// 期间的源端消息只会在源 broker 上堆积。
#[tauri::command]
pub async fn save_parameter(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: ParameterSpec,
    original_name: Option<String>,
) -> AppResult<ParameterSnapshot> {
    let review = review_parameter(&spec);
    if review.is_blocking() {
        return Err(AppError::Invalid(review.errors.join("；")));
    }
    let value = review
        .value
        .ok_or_else(|| AppError::Invalid("参数值无法解析".to_owned()))?;

    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;

    client
        .put_parameter(spec.component, &spec.vhost, &spec.name, &value)
        .await?;

    if let Some(original) = original_name.as_deref()
        && !original.trim().is_empty()
        && original != spec.name
    {
        client
            .delete_parameter(spec.component, &spec.vhost, original)
            .await?;
    }

    client.parameters().await
}

/// 删除参数。
#[tauri::command]
pub async fn delete_parameter(
    state: State<'_, AppState>,
    id: ConnectionId,
    component: ParameterComponent,
    vhost: String,
    name: String,
) -> AppResult<ParameterSnapshot> {
    let verdict = ParameterRemoval::evaluate(component, &name);
    if !verdict.allowed {
        return Err(AppError::Invalid(verdict.detail));
    }

    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;
    client.delete_parameter(component, &vhost, &name).await?;
    client.parameters().await
}
