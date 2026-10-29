//! RabbitMQ 账户管理命令：vhost、用户、权限。
//!
//! 与其他命令同构：解析参数 → 取连接 → 交给 `broker` 层 → 转换错误。
//! 「能不能删」这类判定在 `domain::admin`，这里只做编排与不可逆操作的守卫。
//!
//! 读侧刻意分成三次可以各自失败的请求（vhost / 用户 / 权限），因为它们的
//! 可见性在受限账号上并不一致：只有 `management` 标签的账号看得到 vhost，
//! 看不到 `/api/permissions`。合成一个大命令只会让一处 403 拖垮整页。

use tauri::State;

use crate::domain::admin::{
    PasswordVerdict, UserInfo, UserSpec, VhostRow, check_password, check_user_removal,
    check_vhost_removal,
};
use crate::domain::{ConnectionId, PermissionInfo};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::trace;

/// 账户页的一次性快照。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminSnapshot {
    pub vhosts: Vec<VhostRow>,
    pub users: Vec<UserInfo>,
    /// 权限列表。受限账号读不到时为 `None`，页面据此显示「看不到」而不是「没有」。
    pub permissions: Option<Vec<PermissionInfo>>,
    /// 读侧降级的原因，逐条展示。
    pub notes: Vec<String>,
    /// 当前连接使用的账号。界面上要标出来 —— 删掉它等于把自己锁在门外。
    pub current_user: String,
    /// 当前连接的 vhost。
    pub current_vhost: String,
}

/// 读出账户页需要的全部数据。
#[tauri::command]
pub async fn load_admin(state: State<'_, AppState>, id: ConnectionId) -> AppResult<AdminSnapshot> {
    let connection = state.connections.get(&id).await?;
    let client = connection.as_rabbitmq()?;

    // vhost 是这张表的主体，它读不到就真的没什么可展示了 —— 这一处不降级。
    let (vhosts, mut notes) = client.vhost_rows().await?;

    let users = client.users().await?;

    // 权限在受限账号上是 403。页面要能区分「没有权限记录」和「看不到权限记录」，
    // 所以这里保留 `None`，而不是回一个空数组。
    let permissions = match client.permissions().await {
        Ok(items) => Some(items),
        Err(error) => {
            notes.push(format!(
                "权限列表读不到：{error}。当前账号可能没有 administrator 标签"
            ));
            None
        }
    };

    let config = client.config();
    Ok(AdminSnapshot {
        vhosts,
        users,
        permissions,
        notes,
        current_user: config.auth.username.clone(),
        current_vhost: config.auth.vhost.clone(),
    })
}

/// 新建 / 修改 vhost。
///
/// 管理 API 是 PUT 语义：已存在时为「改描述」。界面上「新建」与「编辑描述」
/// 因此是同一个动作，只是提示文案不同 —— 拼错名字时静默改掉别人的描述
/// 是最难查的一类问题。
#[tauri::command]
pub async fn save_vhost(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
    description: String,
) -> AppResult<Vec<VhostRow>> {
    crate::commands::trace::traced(
        "save_vhost",
        || format!("id={id}, name={name}, description={description}"),
        async {
            let name = name.trim().to_owned();
            if name.is_empty() {
                return Err(AppError::Invalid("vhost 名称不能为空".to_owned()));
            }

            let connection = state.connections.get(&id).await?;
            let client = connection.as_rabbitmq()?;
            client.put_vhost(&name, description.trim()).await?;

            let (rows, _) = client.vhost_rows().await?;
            Ok(rows)
        },
    )
    .await
}

/// 删除 vhost。不可逆：里面的队列、消息、权限、策略一起消失。
#[tauri::command]
pub async fn delete_vhost(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<Vec<VhostRow>> {
    crate::commands::trace::traced("delete_vhost", || format!("id={id}, name={name}"), async {
        check_vhost_removal(&name).map_err(|block| AppError::Invalid(block.reason()))?;

        let connection = state.connections.get(&id).await?;
        let client = connection.as_rabbitmq()?;
        client.delete_vhost(name.trim()).await?;

        let (rows, _) = client.vhost_rows().await?;
        Ok(rows)
    })
    .await
}

/// 用户的保存结果，带上口令强度提示。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSaveOutcome {
    pub users: Vec<UserInfo>,
    /// 口令太弱时的提醒（不阻断保存，服务端也不会管）。
    pub password_warning: Option<String>,
}

/// 新建 / 修改用户。
#[tauri::command]
pub async fn save_user(
    state: State<'_, AppState>,
    id: ConnectionId,
    spec: UserSpec,
    original_name: Option<String>,
) -> AppResult<UserSaveOutcome> {
    crate::commands::trace::traced(
        "save_user",
        || format!("id={id}, spec={}", trace::brief(&spec)),
        async {
            let editing = original_name
                .as_deref()
                .is_some_and(|name| !name.trim().is_empty());
            spec.validate(editing)
                .map_err(|block| AppError::Invalid(block.reason()))?;

            let password_warning = match check_password(&spec.name, &spec.password) {
                PasswordVerdict::Ok => None,
                verdict => verdict.reason().map(str::to_owned),
            };

            let connection = state.connections.get(&id).await?;
            let client = connection.as_rabbitmq()?;
            client.save_user(&spec).await?;

            // 改名不是原子操作：管理 API 没有 rename。顺序必须是「先建新的、再删旧的」，
            // 反过来会有一段时间这个账号完全不存在，正在跑的消费者会集体掉线。
            if let Some(original) = original_name.as_deref()
                && !original.trim().is_empty()
                && original.trim() != spec.name.trim()
            {
                client.delete_user(original.trim()).await?;
            }

            Ok(UserSaveOutcome {
                users: client.users().await?,
                password_warning,
            })
        },
    )
    .await
}

/// 删除用户。连带删除它在所有 vhost 上的权限。
#[tauri::command]
pub async fn delete_user(
    state: State<'_, AppState>,
    id: ConnectionId,
    name: String,
) -> AppResult<Vec<UserInfo>> {
    crate::commands::trace::traced("delete_user", || format!("id={id}, name={name}"), async {
        let connection = state.connections.get(&id).await?;
        let current = connection.as_rabbitmq()?.config().auth.username.clone();
        check_user_removal(&name, &current).map_err(|block| AppError::Invalid(block.reason()))?;

        let client = connection.as_rabbitmq()?;
        client.delete_user(name.trim()).await?;
        client.users().await
    })
    .await
}

/// 授权 / 改权限。三段正则覆盖写入，没写的那段会被置空。
#[tauri::command]
pub async fn save_permission(
    state: State<'_, AppState>,
    id: ConnectionId,
    permission: PermissionInfo,
) -> AppResult<Vec<PermissionInfo>> {
    crate::commands::trace::traced(
        "save_permission",
        || format!("id={id}, spec={}", trace::brief(&permission)),
        async {
            if permission.user.trim().is_empty() {
                return Err(AppError::Invalid("请选择要授权的用户".to_owned()));
            }
            if permission.vhost.trim().is_empty() {
                return Err(AppError::Invalid("请选择 vhost".to_owned()));
            }

            let connection = state.connections.get(&id).await?;
            let client = connection.as_rabbitmq()?;
            client
                .save_permission(
                    permission.user.trim(),
                    permission.vhost.trim(),
                    permission.configure.trim(),
                    permission.write.trim(),
                    permission.read.trim(),
                )
                .await?;
            client.permissions().await
        },
    )
    .await
}

/// 撤销某个用户在一个 vhost 上的全部权限。
#[tauri::command]
pub async fn delete_permission(
    state: State<'_, AppState>,
    id: ConnectionId,
    user: String,
    vhost: String,
) -> AppResult<Vec<PermissionInfo>> {
    crate::commands::trace::traced(
        "delete_permission",
        || format!("id={id}, user={user}, vhost={vhost}"),
        async {
            let connection = state.connections.get(&id).await?;
            let client = connection.as_rabbitmq()?;
            client.delete_permission(user.trim(), vhost.trim()).await?;
            client.permissions().await
        },
    )
    .await
}
