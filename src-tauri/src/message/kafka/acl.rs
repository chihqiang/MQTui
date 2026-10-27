//! ACL 的编排：把 broker 的原始结果交给领域规则组装成一张能读的表。
//!
//! 这一层只做三件事：调 FFI、把「问不了」翻译成带解释的快照、
//! 把读取失败分成「版本不支持」与「你没权限看」两种 —— 它们的下一步动作完全不同，
//! 合成一个错误会把人送去查版本，而真正该做的是给自己加一条 `DESCRIBE`。

use crate::broker::kafka::{KafkaClient, acl as admin};
use crate::domain::{AclFilter, AclSnapshot, assemble_acls};
use crate::error::{AppError, AppResult};

/// 读取 ACL。
///
/// 不支持的 broker 返回带 `unsupported` 的快照而不是 `Err`：那是这一屏的正常状态，
/// 把整页做成错误页会把「这台集群没开授权」说成「面板坏了」。
pub async fn acls(client: &KafkaClient, filter: AclFilter) -> AppResult<AclSnapshot> {
    match admin::describe(client, filter).await {
        Ok(entries) => Ok(assemble_acls(entries, None)),
        Err(AppError::Unsupported(reason)) => Ok(assemble_acls(Vec::new(), Some(reason))),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_snapshot_keeps_the_reason() {
        let snapshot = assemble_acls(Vec::new(), Some("需要 2.0 以上".to_owned()));
        assert!(snapshot.unsupported.is_some());
        // 不支持时不能给「改去用 kafka-acls.sh」这类提示 —— 这里压根没有 ACL 可改。
        assert!(
            !snapshot
                .notes
                .iter()
                .any(|note| note.contains("kafka-acls"))
        );
    }
}
