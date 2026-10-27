//! 账户管理的读写编排：vhost、用户、权限。
//!
//! 与 `management.rs` 的分工和 `runtime.rs` 一致：那边只管发请求与解析字段，
//! 这边负责「把几次请求拼成一张能读的表」和「写之前先把口令变成 RabbitMQ
//! 认的哈希」这类编排。
//!
//! 三处刻意的取舍：
//!
//! 1. **权限列表拉不到不许连坐**。受限账号（只有 `management` 标签）看不到
//!    `/api/permissions`，但 vhost 与队列数是能看的 —— 一次 403 不该让整页空掉，
//!    所以这里把错误降级成一条说明。
//! 2. **新建用户必须给出哈希**。管理 API 的 `password_hash` 只认
//!    `base64(salt + sha256(salt + password))`；把明文塞进这个字段，服务端会
//!    当成哈希存下来，账号「建好了」但谁也登不上，而且不会报任何错。
//! 3. **vhost 与用户的增删是两条独立路径**，不顺手套一层「顺手把权限也删了」：
//!    删用户时服务端自己会清权限，而删权限是另一个明确的动作。

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::domain::{PermissionInfo, UserInfo, UserSpec, VhostInfo, VhostRow, assemble_vhosts};
use crate::error::AppResult;

use super::client::RabbitMqClient;

impl RabbitMqClient {
    /// vhost 汇总表：vhost 本体 + 队列数 + 权限数。
    ///
    /// 队列数与权限数各自可能失败（前者要 `/api/queues`，后者在受限账号上 403），
    /// 失败时按空处理并把原因带回去 —— 表照常可读，只是那两列显示为 0。
    pub async fn vhost_rows(&self) -> AppResult<(Vec<VhostRow>, Vec<String>)> {
        let management = self.management()?;
        let config = self.config();
        let vhosts = management.vhosts(config).await?;

        let mut notes: Vec<String> = Vec::new();

        // 队列数与权限数各自可能失败（前者要 `/api/queues`，后者在受限账号上 403），
        // 失败时按空处理并把原因带回去 —— 表照常可读，只是那两列显示为 0。
        let queue_counts = match management.queue_counts(config).await {
            Ok(counts) => counts,
            Err(error) => {
                notes.push(format!("队列数读不到：{error}"));
                Vec::new()
            }
        };

        let permissions = match management.permissions(config).await {
            Ok(items) => items,
            Err(error) => {
                notes.push(format!(
                    "权限读不到（受限账号看不到 /api/permissions）：{error}"
                ));
                Vec::new()
            }
        };

        Ok((assemble_vhosts(&vhosts, &queue_counts, &permissions), notes))
    }

    /// 全部 vhost。列表页建完之后要回填，所以这里单独开一个。
    pub async fn vhosts(&self) -> AppResult<Vec<VhostInfo>> {
        let management = self.management()?;
        management.vhosts(self.config()).await
    }

    pub async fn put_vhost(&self, name: &str, description: &str) -> AppResult<()> {
        let management = self.management()?;
        management.put_vhost(self.config(), name, description).await
    }

    pub async fn delete_vhost(&self, name: &str) -> AppResult<()> {
        let management = self.management()?;
        management.delete_vhost(self.config(), name).await
    }

    /// 全部用户。
    pub async fn users(&self) -> AppResult<Vec<UserInfo>> {
        let management = self.management()?;
        management.users(self.config()).await
    }

    /// 新建或修改用户。`password` 为空表示不改密码（编辑场景）。
    pub async fn save_user(&self, spec: &UserSpec) -> AppResult<()> {
        let management = self.management()?;
        let hash = if spec.password.is_empty() {
            None
        } else {
            Some(hash_password(&spec.password))
        };
        management
            .put_user(self.config(), spec, hash.as_deref())
            .await
    }

    pub async fn delete_user(&self, name: &str) -> AppResult<()> {
        let management = self.management()?;
        management.delete_user(self.config(), name).await
    }

    /// 全部权限。受限账号上会失败，由调用方决定怎么降级。
    pub async fn permissions(&self) -> AppResult<Vec<PermissionInfo>> {
        let management = self.management()?;
        management.permissions(self.config()).await
    }

    pub async fn save_permission(
        &self,
        user: &str,
        vhost: &str,
        configure: &str,
        write: &str,
        read: &str,
    ) -> AppResult<()> {
        let management = self.management()?;
        management
            .put_permission(self.config(), user, vhost, configure, write, read)
            .await
    }

    pub async fn delete_permission(&self, user: &str, vhost: &str) -> AppResult<()> {
        let management = self.management()?;
        management
            .delete_permission(self.config(), user, vhost)
            .await
    }
}

/// 按 RabbitMQ 的规则算口令哈希：`base64(salt || sha256(salt || password))`。
///
/// 这是管理 API 唯一接受的格式（字段名 `password_hash`）。用 4 字节随机盐，
/// 与服务端 `rabbit_password_hashing_sha256` 的实现一致 —— 盐短不影响安全性，
/// 因为它的作用是「同一个密码在不同用户上算出不同哈希」。
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 4];
    rand::fill(&mut salt);
    hash_password_with_salt(password, &salt)
}

/// 定盐版本，供单测与「需要可复现」的场合使用。
pub fn hash_password_with_salt(password: &str, salt: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();

    let mut raw = Vec::with_capacity(salt.len() + digest.len());
    raw.extend_from_slice(salt);
    raw.extend_from_slice(&digest);
    base64::engine::general_purpose::STANDARD.encode(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_shape_matches_rabbitmq_layout() {
        let encoded = hash_password_with_salt("secret", &[1, 2, 3, 4]);
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .expect("必须是合法 base64");
        // 4 字节盐 + 32 字节 sha256
        assert_eq!(raw.len(), 36);
        assert_eq!(&raw[..4], &[1, 2, 3, 4]);
    }

    #[test]
    fn same_password_different_salt_yields_different_hash() {
        // 盐的唯一作用就是这一条：不让同一个密码在库里长得一样。
        let a = hash_password_with_salt("secret", &[1, 2, 3, 4]);
        let b = hash_password_with_salt("secret", &[4, 3, 2, 1]);
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_deterministic_with_fixed_salt() {
        assert_eq!(
            hash_password_with_salt("secret", &[9, 9, 9, 9]),
            hash_password_with_salt("secret", &[9, 9, 9, 9])
        );
    }

    #[test]
    fn random_salt_varies() {
        assert_ne!(hash_password("secret"), hash_password("secret"));
    }
}
