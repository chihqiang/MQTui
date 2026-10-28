//! ACL 的编排：把 broker 的原始结果交给领域规则组装成一张能读的表。
//!
//! 这一层只做三件事：调 FFI、把「问不了」翻译成带解释的快照、
//! 把读取失败分成「版本不支持」与「你没权限看」两种 —— 它们的下一步动作完全不同，
//! 合成一个错误会把人送去查版本，而真正该做的是给自己加一条 `DESCRIBE`。

use crate::broker::kafka::{KafkaClient, acl as admin};
use crate::domain::{
    AclChangePlan, AclFilter, AclSnapshot, AclWriteRequest, assemble_acls,
    plan_acl_create as plan_create, plan_acl_delete as plan_delete,
};
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

/// 一次写入的执行回执。
///
/// 与 `AclChangePlan` 分开：预演说「会怎样」，回执说「实际怎样」。两者不能合并 ——
/// 合并之后，界面就只能拿预演的结果当结论，而预演可能已经过期。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AclWriteReport {
    pub outcomes: Vec<crate::broker::kafka::acl::AclWriteOutcome>,
    /// 成功的条数（删除时按真正删掉的条数算）。
    pub applied: usize,
    /// 需要用户知道的事实。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl AclWriteReport {
    /// 一句话结论。
    pub fn verdict(&self) -> String {
        let failed = self.outcomes.iter().filter(|item| !item.ok).count();
        if self.outcomes.is_empty() {
            return "没有任何规则被提交".to_owned();
        }
        if failed == 0 {
            return format!("{} 条规则已全部生效", self.outcomes.len());
        }
        format!(
            "{} 条规则里 {} 条成功、{failed} 条失败",
            self.outcomes.len(),
            self.outcomes.len() - failed
        )
    }
}

/// 预演新增：读一次当前全部 ACL，再和要提交的规则比对。
///
/// 必须读**全部**规则：拿用户当前筛选后的那张表去比对，「筛了主题之后新增」
/// 会把集群上早就有的规则报成「新增」。
pub async fn preview_create(
    client: &KafkaClient,
    request: AclWriteRequest,
) -> AppResult<AclChangePlan> {
    // 预演可以不带确认名 —— 那一步是在提交时才需要复述的。
    if request.entries.is_empty() {
        return Err(AppError::Invalid("没有选中任何规则".to_owned()));
    }
    for entry in &request.entries {
        crate::domain::validate_acl_entry(entry).map_err(AppError::Invalid)?;
    }
    let existing = current(client).await?;
    Ok(plan_create(&existing, &request.entries))
}

/// 预演删除。
pub async fn preview_delete(
    client: &KafkaClient,
    request: AclWriteRequest,
) -> AppResult<AclChangePlan> {
    if request.entries.is_empty() {
        return Err(AppError::Invalid("没有选中任何规则".to_owned()));
    }
    for entry in &request.entries {
        crate::domain::validate_acl_entry(entry).map_err(AppError::Invalid)?;
    }
    let existing = current(client).await?;
    Ok(plan_delete(&existing, &request.entries))
}

/// 提交新增。
///
/// 提交前**重新算一遍**预演，不复用界面上的那份：确认框可能开着几十秒，
/// 期间别人可能刚改过 ACL。按预览那一刻的结论去写，会把刚被别人加的规则再写一遍，
/// 或者漏掉刚被别人删掉的冲突。
pub async fn commit_create(
    client: &KafkaClient,
    request: AclWriteRequest,
) -> AppResult<AclWriteReport> {
    request.validate().map_err(AppError::Invalid)?;
    let existing = current(client).await?;
    let plan = plan_create(&existing, &request.entries);

    // 全部「已存在」时什么都不用发：服务端对这个操作是幂等的，
    // 但多发一次就多一次失败的机会，而这个操作能失败的方式（权限、版本）都是静默的。
    if plan.effective == 0 {
        return Ok(AclWriteReport {
            outcomes: plan
                .changes
                .into_iter()
                .map(|change| {
                    let message = change.note();
                    crate::broker::kafka::acl::AclWriteOutcome {
                        entry: change.entry,
                        ok: true,
                        message,
                        matched: 0,
                    }
                })
                .collect(),
            applied: 0,
            notes: vec!["这些规则提交前就已经在集群上，没有发出写入请求".to_owned()],
        });
    }

    let outcomes = admin::create(client, request.entries).await?;
    Ok(report_of(outcomes, "新建"))
}

/// 提交删除。
pub async fn commit_delete(
    client: &KafkaClient,
    request: AclWriteRequest,
) -> AppResult<AclWriteReport> {
    request.validate().map_err(AppError::Invalid)?;
    let outcomes = admin::delete(client, request.entries).await?;
    Ok(report_of(outcomes, "删除"))
}

fn report_of(
    outcomes: Vec<crate::broker::kafka::acl::AclWriteOutcome>,
    action: &str,
) -> AclWriteReport {
    let applied = outcomes
        .iter()
        .filter(|item| item.ok)
        .map(|item| item.matched.max(1))
        .sum();
    let mut notes = Vec::new();
    // 命中数 > 1 是「过滤器比想象中宽」的证据，必须单独说 —— 用户以为删了一条。
    let wide: Vec<&str> = outcomes
        .iter()
        .filter(|item| item.ok && item.matched > 1)
        .map(|item| item.entry.principal.as_str())
        .collect();
    if !wide.is_empty() {
        notes.push(format!(
            "有 {} 条规则实际命中了不止一条 ACL（可能包含前缀匹配或通配规则），请刷新核对",
            wide.len()
        ));
    }
    if outcomes
        .iter()
        .any(|item| item.ok && item.matched == 0 && action == "删除")
    {
        notes.push("部分规则在提交前就已经不在集群上，删除时没有命中任何一条".to_owned());
    }
    // 成功但没给出命中条数（`matched = 0` 且不是删除）只能来自「跳过」路径，
    // 这里不重复提示；删除那条已经在上面单独说过了。
    let unconfirmed: Vec<&str> = outcomes
        .iter()
        .filter(|item| !item.ok && item.message.contains("回执条数与请求不一致"))
        .map(|item| item.entry.principal.as_str())
        .collect();
    if !unconfirmed.is_empty() {
        notes.push(format!(
            "有 {} 条规则的删除回执对不上（服务端返回的结果里没有它们的命中记录），这一批的实际结果请以刷新后的列表为准",
            unconfirmed.len()
        ));
    }
    AclWriteReport {
        outcomes,
        applied,
        notes,
    }
}

/// 读当前集群上的全部 ACL 规则。
///
/// 「不支持」在这里不是空表：那说明这台 broker 压根没有授权器，写入无从谈起。
/// 返回空表会让预演把每一条都报成「新增」—— 而它们一条都写不进去。
async fn current(client: &KafkaClient) -> AppResult<Vec<crate::domain::AclEntry>> {
    match admin::describe(client, AclFilter::default()).await {
        Ok(entries) => Ok(entries),
        Err(AppError::Unsupported(reason)) => Err(AppError::Unsupported(reason)),
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
