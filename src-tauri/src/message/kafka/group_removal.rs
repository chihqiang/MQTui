//! 删除消费组前的预检：读一次组成员，把「会被服务端拒绝」提前说清楚。
//!
//! 判定规则全在 `domain::group_removal`，这里只负责取数据。
//!
//! 两个刻意的取舍：
//!
//! - **逐个组读，不批量**。`fetch_group_list` 前缀匹配会顺带返回别的组，
//!   而这里要问的是「这 N 个组各自的成员」，逐个精确比对才不会有歧义。
//! - **单个组读失败不拖垮整批**。组名打错了、权限不够，都会让那一个组变成
//!   `unknown`，其余组照常给出结论 —— 整批报错等于什么都没预检。

use std::sync::Arc;

use rdkafka::ClientConfig;
use rdkafka::consumer::BaseConsumer;

use crate::broker::kafka::{KafkaClient, admin};
use crate::domain::group_removal::{
    GroupRemovalPreflight, all_unknown, assemble, check, normalize_names, unknown_check,
};
use crate::domain::{ConsumerGroupDetail, KeyValue};
use crate::error::{AppError, AppResult};

/// 读组成员用的 group.id 前缀，与其它面板查询保持一套命名。
const GROUP_PREFIX: &str = "mqtui-removal";

/// 预检一批消费组能否删除。
pub async fn preflight(
    client: &KafkaClient,
    groups: Vec<String>,
) -> AppResult<GroupRemovalPreflight> {
    let names = normalize_names(groups);
    if names.is_empty() {
        return Err(AppError::Invalid("请先选择要删除的消费组".to_owned()));
    }

    let config = Arc::new(inspection_config(client));
    let list = names.clone();

    // 组成员接口是同步语义：一次 spawn_blocking 读完这一批，而不是每组一次，
    // 否则 20 个组会排 20 次线程切换。
    let outcome = tokio::task::spawn_blocking(move || {
        let worker = build(&config)?;
        Ok::<_, AppError>(
            list.into_iter()
                // `fetch_detail` 内部按完整组名精确比对，`orders` 吃不到 `orders-v2`。
                .map(|name| match admin::fetch_detail(&worker, &name) {
                    Ok(detail) => Ok(check(&detail)),
                    Err(error) => Err((name, error.to_string())),
                })
                .collect::<Vec<Result<_, (String, String)>>>(),
        )
    })
    .await
    .map_err(|error| AppError::Internal(format!("消费组预检任务失败: {error}")))??;

    let mut checks = Vec::new();
    let mut unknown: Vec<KeyValue> = Vec::new();
    for item in outcome {
        match item {
            Ok(result) => checks.push(result),
            Err((name, reason)) => {
                unknown.push(KeyValue::new(name.clone(), reason.clone()));
                checks.push(unknown_check(&name, reason));
            }
        }
    }

    Ok(assemble(checks, unknown))
}

/// 整批连客户端都建不起来时的兜底。
///
/// 不这么做的话，一个建连失败会让确认框里的预检整块变成错误态；
/// 而删除本身可能仍然能成功 —— 预检是辅助，不该成为拦路石。
pub fn degraded(groups: &[String], reason: &str) -> GroupRemovalPreflight {
    all_unknown(&normalize_names(groups.to_vec()), reason.to_owned())
}

/// 面板侧查询用的 consumer 配置：只读，绝不写回业务组位点。
fn inspection_config(client: &KafkaClient) -> ClientConfig {
    client.consumer_config(&format!("{GROUP_PREFIX}-{}", uuid::Uuid::new_v4()))
}

fn build(config: &ClientConfig) -> AppResult<BaseConsumer> {
    config.create().map_err(AppError::from)
}

/// 仅供测试：把失败翻译成一句话，方便断言「读不到时不拦」。
pub fn describe_failure(detail: &ConsumerGroupDetail) -> String {
    if detail.members.is_empty() {
        "没有在线成员".to_owned()
    } else {
        format!("{} 个在线成员", detail.members.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::consumer::{ConsumerGroupInfo, ConsumerGroupMember};

    #[test]
    fn degraded_batch_never_blocks() {
        let report = degraded(
            &["orders".to_owned(), " orders ".to_owned()],
            "连不上 broker",
        );
        assert!(!report.has_blocked);
        assert_eq!(report.unknown.len(), 1, "同名组应去重");
        assert!(report.headline.contains("无法预判"));
    }

    #[test]
    fn failure_description_mentions_member_count() {
        let detail = ConsumerGroupDetail {
            group: ConsumerGroupInfo {
                name: "orders".to_owned(),
                state: "Stable".to_owned(),
                members: 2,
                total_lag: None,
            },
            members: vec![
                ConsumerGroupMember {
                    member_id: Some("m-1".to_owned()),
                    client_id: None,
                    client_host: None,
                },
                ConsumerGroupMember {
                    member_id: Some("m-2".to_owned()),
                    client_id: None,
                    client_host: None,
                },
            ],
            offsets: Vec::new(),
        };
        assert_eq!(describe_failure(&detail), "2 个在线成员");
    }
}
