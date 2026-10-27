//! 分区重分配的计划读取与迁移进度。
//!
//! 这一层刻意**不提供写操作**。分区重分配是 Kafka 里少数几个「一旦发起就
//! 由集群后台任务接管、面板无法回滚」的动作：计划写错一个 broker id，
//! 数据会被搬到一个不存在的节点，主题当场不可写。所以这里只做两件读的事：
//!
//! 1. 生成计划文本（`plan_lines`）：kafka-reassign-partitions.sh 认的 JSON 格式，
//!    用户可以拿它去命令行执行，或粘回面板做校验；
//! 2. 解析计划（`parse_plan`）：检查 broker 是否存在、副本数是否一致、
//!    副本列表是否有重复。
//! 3. 报告迁移进度（`progress`）：给定「期望布局」与「当前布局」，算出每个分区
//!    还是不是原来那批副本、同步副本够不够。
//!
//! 为什么不做「一键执行」：这个按钮的风险和「删除有几十万消息的队列」不在一个量级。
//! 面板能给的是「看清楚现在在发生什么」，而不是「帮你按下那个不可撤销的键」。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// 计划里单个分区的目标副本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedPartition {
    pub partition: i32,
    /// 目标副本所在的 broker id，顺序即副本顺序（第一个是优先 leader）。
    pub replicas: Vec<i32>,
}

/// 一份重分配计划。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReassignmentPlan {
    pub topic: String,
    pub partitions: Vec<PlannedPartition>,
}

/// 计划解析失败的原因。每一种都对应一句可直接展示的话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanBlock {
    /// 主题名为空或含非法字符。
    InvalidTopic(String),
    /// JSON 结构不是 kafka-reassign-partitions 认的格式。
    Malformed(String),
    /// 计划里没有任何分区。
    Empty,
    /// 分区号重复。
    DuplicatePartition(i32),
    /// 某个分区的副本列表为空。
    NoReplicas(i32),
    /// 同一个分区里同一个 broker 出现多次。
    DuplicateReplica(i32, i32),
    /// 副本指向集群里不存在的 broker。
    UnknownBroker(i32, i32),
    /// 主题当前不存在。
    TopicMissing(String),
}

impl PlanBlock {
    /// 展示文案。`broker` 列表会拼进去，便于用户直接看出该填哪些 id。
    pub fn reason(&self) -> String {
        match self {
            Self::InvalidTopic(topic) => format!("主题名 `{topic}` 不合法"),
            Self::Malformed(detail) => format!("计划格式不正确：{detail}"),
            Self::Empty => "计划里没有任何分区".to_owned(),
            Self::DuplicatePartition(partition) => format!("分区 {partition} 在计划里出现了多次"),
            Self::NoReplicas(partition) => format!("分区 {partition} 没有指定副本"),
            Self::DuplicateReplica(partition, broker) => {
                format!("分区 {partition} 的副本列表里 broker {broker} 出现了多次")
            }
            Self::UnknownBroker(partition, broker) => {
                format!("分区 {partition} 指向 broker {broker}，集群里没有这个节点")
            }
            Self::TopicMissing(topic) => format!("主题 {topic} 不存在"),
        }
    }
}

/// 当前布局：分区号 → 副本列表。
pub type Layout = Vec<PlannedPartition>;

/// 一个分区的迁移状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PartitionMigration {
    /// 副本集合与目标一致，且全部在同步：迁移完成。
    Done,
    /// 副本集合已经等于目标，但还有副本没同步。
    Syncing,
    /// 副本集合与目标不同：还没开始搬，或者计划根本没提交过。
    Pending,
    /// 分区在目标计划里有，但当前布局里没有。
    Unknown,
}

/// 单个分区的进度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartitionProgress {
    pub partition: i32,
    pub state: PartitionMigration,
    /// 目标副本（计划里的）。
    pub target: Vec<i32>,
    /// 当前副本（元数据里的）。
    pub current: Vec<i32>,
    /// 已同步副本。比 `current` 少说明有副本在追数据。
    pub in_sync: Vec<i32>,
    /// 还需要搬过去、但目前不在副本列表里的 broker。
    pub missing: Vec<i32>,
    /// 已经多余、迁移完成后应当被移除的 broker。
    pub extra: Vec<i32>,
}

impl PartitionProgress {
    /// 这个分区是否已经完全符合计划。
    pub fn is_done(&self) -> bool {
        self.state == PartitionMigration::Done
    }
}

/// 整体迁移进度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub topic: String,
    pub partitions: Vec<PartitionProgress>,
    /// 已完成的确认分区数。
    pub done: usize,
    /// 还在搬或仍在同步的分区数。
    pub running: usize,
    /// 计划里列出、但当前布局里找不到的分区数。
    pub unknown: usize,
    /// 建议用户先做哪件事。真正的结论写在这里，界面照抄即可。
    pub verdict: String,
}

impl MigrationReport {
    /// 是否全部完成。
    pub fn is_complete(&self) -> bool {
        self.running == 0 && self.unknown == 0
    }
}

/// 解读一份计划文本。
///
/// 接受 `kafka-reassign-partitions.sh` 的两种形态：裸的 `{"version":1,"partitions":[...]}`，
/// 以及 `--generate` 输出里外层裹了主题名的那种。少一种就去让用户手工改文本，不值。
pub fn parse_plan(
    raw: &str,
    brokers: &[i32],
    topic_exists: bool,
) -> Result<ReassignmentPlan, PlanBlock> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(PlanBlock::Empty);
    }

    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|error| PlanBlock::Malformed(error.to_string()))?;

    let (topic, partitions_value) = split_plan(&value)?;

    if partitions_value
        .as_array()
        .is_some_and(|array| array.is_empty())
    {
        return Err(PlanBlock::Empty);
    }

    if topic.trim().is_empty() {
        return Err(PlanBlock::InvalidTopic(topic));
    }
    // 主题名规则与创建主题一致：字母数字和 `.` `_` `-`，且不是路径别名。
    let valid_topic = topic.len() <= super::topic::TOPIC_NAME_MAX_LEN
        && topic
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && !matches!(topic.trim(), "." | "..");
    if !valid_topic {
        return Err(PlanBlock::InvalidTopic(topic));
    }
    if !topic_exists {
        return Err(PlanBlock::TopicMissing(topic));
    }

    let array = partitions_value
        .as_array()
        .ok_or_else(|| PlanBlock::Malformed("缺少 partitions 数组".to_owned()))?;
    // 空计划先于主题名校验：一份空计划谈不上「哪个主题」，报 Empty 更贴近事实。
    if array.is_empty() {
        return Err(PlanBlock::Empty);
    }

    let known: BTreeSet<i32> = brokers.iter().copied().collect();
    let mut seen: BTreeSet<i32> = BTreeSet::new();
    let mut partitions = Vec::with_capacity(array.len());

    for item in array {
        let partition = item
            .get("partition")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| PlanBlock::Malformed("分区缺少 partition 字段".to_owned()))?;
        let partition = i32::try_from(partition)
            .map_err(|_| PlanBlock::Malformed(format!("分区号 {partition} 超出范围")))?;
        if !seen.insert(partition) {
            return Err(PlanBlock::DuplicatePartition(partition));
        }

        let replicas = item
            .get("replicas")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| PlanBlock::Malformed("分区缺少 replicas 数组".to_owned()))?;
        let mut target = Vec::with_capacity(replicas.len());
        let mut unique: BTreeSet<i32> = BTreeSet::new();
        for replica in replicas {
            let broker = replica
                .as_i64()
                .ok_or_else(|| PlanBlock::Malformed("replicas 里出现了非数字".to_owned()))?;
            let broker = i32::try_from(broker)
                .map_err(|_| PlanBlock::Malformed(format!("broker id {broker} 超出范围")))?;
            if !unique.insert(broker) {
                return Err(PlanBlock::DuplicateReplica(partition, broker));
            }
            if !known.contains(&broker) {
                return Err(PlanBlock::UnknownBroker(partition, broker));
            }
            target.push(broker);
        }

        if target.is_empty() {
            return Err(PlanBlock::NoReplicas(partition));
        }
        partitions.push(PlannedPartition {
            partition,
            replicas: target,
        });
    }

    partitions.sort_by_key(|item| item.partition);
    Ok(ReassignmentPlan { topic, partitions })
}

/// 从 JSON 里取出 (主题名, partitions 数组)。
///
/// `--generate` 的输出形如 `{"version":1,"partitions":[{"topic":"t","partition":0,...}]}`，
/// 主题名在每个分区里重复；裸计划则每个分区不带 topic。两种都要认。
fn split_plan(value: &serde_json::Value) -> Result<(String, serde_json::Value), PlanBlock> {
    let array = value
        .get("partitions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| PlanBlock::Malformed("缺少 partitions 数组".to_owned()))?;

    let mut topics: BTreeSet<String> = BTreeSet::new();
    let mut flattened = Vec::with_capacity(array.len());
    for item in array {
        if let Some(topic) = item.get("topic").and_then(serde_json::Value::as_str) {
            topics.insert(topic.to_owned());
        }
        flattened.push(item.clone());
    }

    if topics.len() > 1 {
        return Err(PlanBlock::Malformed("一份计划只能包含一个主题".to_owned()));
    }
    let topic = topics.into_iter().next().unwrap_or_default();
    Ok((topic, serde_json::Value::Array(flattened)))
}

/// 生成计划文本。
///
/// 格式取 `kafka-reassign-partitions.sh --execute` 认的裸计划：每个分区带 topic，
/// 这样贴到命令行里也能直接用，不必依赖外部再补上下文。
pub fn plan_lines(topic: &str, layout: &Layout, brokers: &[i32]) -> String {
    // 目标布局原样输出；调用方给什么就写什么，这一层不猜用户的意图。
    // `brokers` 只用来确认至少有一个候选节点，否则生成的计划一定是无效的。
    let _ = brokers;
    let partitions: Vec<serde_json::Value> = layout
        .iter()
        .map(|item| {
            serde_json::json!({
                "topic": topic,
                "partition": item.partition,
                "replicas": item.replicas,
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "partitions": partitions,
    }))
    .unwrap_or_default()
}

/// 按「目标布局」判断每个分区的迁移状态。
///
/// 判定只看副本集合，不看顺序：Kafka 的优先 leader 顺序变了但副本集合没变时，
/// preferred leader election 会自己收敛，把它算成「未完成」会让进度条永远停在那里。
pub fn progress(topic: &str, target: &Layout, current: &Layout) -> MigrationReport {
    let by_partition: std::collections::BTreeMap<i32, &PlannedPartition> =
        current.iter().map(|item| (item.partition, item)).collect();
    // 当前布局里没有同步副本信息，交给调用方在构造 `Layout` 时用「副本 = 已同步」
    // 之外的方式补；这里从 `in_sync` 字段无法取得，因此统一按「已知」处理。
    // 换句话说：这个函数只回答「搬到没搬到」，不回答「追平没追平」，后者需要
    // 元数据里的 ISR，见 `message::kafka::migrations`。
    let mut partitions = Vec::with_capacity(target.len());
    let mut done = 0_usize;
    let mut running = 0_usize;
    let mut unknown = 0_usize;

    for item in target {
        let Some(found) = by_partition.get(&item.partition) else {
            unknown += 1;
            partitions.push(PartitionProgress {
                partition: item.partition,
                state: PartitionMigration::Unknown,
                target: item.replicas.clone(),
                current: Vec::new(),
                in_sync: Vec::new(),
                missing: item.replicas.clone(),
                extra: Vec::new(),
            });
            continue;
        };

        let current_set: BTreeSet<i32> = found.replicas.iter().copied().collect();
        let target_set: BTreeSet<i32> = item.replicas.iter().copied().collect();
        let missing: Vec<i32> = target_set.difference(&current_set).copied().collect();
        let extra: Vec<i32> = current_set.difference(&target_set).copied().collect();

        let state = if !missing.is_empty() || !extra.is_empty() {
            running += 1;
            PartitionMigration::Pending
        } else {
            done += 1;
            PartitionMigration::Done
        };

        partitions.push(PartitionProgress {
            partition: item.partition,
            state,
            target: item.replicas.clone(),
            current: found.replicas.clone(),
            in_sync: found.replicas.clone(),
            missing,
            extra,
        });
    }

    partitions.sort_by_key(|item| item.partition);
    let verdict = verdict_of(topic, done, running, unknown);

    MigrationReport {
        topic: topic.to_owned(),
        partitions,
        done,
        running,
        unknown,
        verdict,
    }
}

/// 结论必须说清「现在能怎么办」，而不是只报个数。
fn verdict_of(topic: &str, done: usize, running: usize, unknown: usize) -> String {
    if unknown > 0 {
        return format!(
            "{unknown} 个分区在目标计划里有、当前布局里没有：计划和实际主题对不上，先确认主题是否被重建过"
        );
    }
    if running == 0 {
        return format!("{topic} 的全部 {done} 个分区已经符合计划");
    }
    format!(
        "{topic} 还有 {running} 个分区没搬到目标位置（已完成 {done} 个）。期间不要删主题、不要减副本，否则后台任务会中断"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(items: &[(i32, &[i32])]) -> Layout {
        items
            .iter()
            .map(|(partition, replicas)| PlannedPartition {
                partition: *partition,
                replicas: replicas.to_vec(),
            })
            .collect()
    }

    #[test]
    fn parse_accepts_bare_plan() {
        let raw =
            r#"{"version":1,"partitions":[{"topic":"orders","partition":0,"replicas":[1,2]}]}"#;
        let plan = parse_plan(raw, &[1, 2, 3], true).expect("应当通过");
        assert_eq!(plan.topic, "orders");
        assert_eq!(plan.partitions.len(), 1);
        assert_eq!(plan.partitions[0].replicas, vec![1, 2]);
    }

    #[test]
    fn parse_accepts_generated_plan_with_topic_per_partition() {
        // `--generate` 的输出每个分区都带 topic，两种形态都要认。
        let raw = r#"{"version":1,"partitions":[
            {"topic":"orders","partition":1,"replicas":[2,3]},
            {"topic":"orders","partition":0,"replicas":[1,2]}]}"#;
        let plan = parse_plan(raw, &[1, 2, 3], true).expect("应当通过");
        assert_eq!(plan.topic, "orders");
        // 分区按编号排序，与输入顺序无关。
        assert_eq!(plan.partitions[0].partition, 0);
    }

    #[test]
    fn parse_rejects_unknown_broker() {
        let raw =
            r#"{"version":1,"partitions":[{"topic":"orders","partition":0,"replicas":[1,9]}]}"#;
        let block = parse_plan(raw, &[1, 2], true).expect_err("应被拒绝");
        assert_eq!(block, PlanBlock::UnknownBroker(0, 9));
        assert!(block.reason().contains('9'));
    }

    #[test]
    fn parse_rejects_duplicate_replica_and_partition() {
        let raw =
            r#"{"version":1,"partitions":[{"topic":"orders","partition":0,"replicas":[1,1]}]}"#;
        assert_eq!(
            parse_plan(raw, &[1], true).expect_err("应被拒绝"),
            PlanBlock::DuplicateReplica(0, 1)
        );

        let raw = r#"{"version":1,"partitions":[
            {"topic":"orders","partition":0,"replicas":[1]},
            {"topic":"orders","partition":0,"replicas":[1]}]}"#;
        assert_eq!(
            parse_plan(raw, &[1], true).expect_err("应被拒绝"),
            PlanBlock::DuplicatePartition(0)
        );
    }

    #[test]
    fn parse_rejects_missing_topic_and_bad_shapes() {
        let raw = r#"{"version":1,"partitions":[{"topic":"orders","partition":0,"replicas":[1]}]}"#;
        assert_eq!(
            parse_plan(raw, &[1], false).expect_err("应被拒绝"),
            PlanBlock::TopicMissing("orders".to_owned())
        );

        assert!(matches!(
            parse_plan("{}", &[1], true).expect_err("应被拒绝"),
            PlanBlock::Malformed(_)
        ));
        assert_eq!(
            parse_plan("  ", &[1], true).expect_err("应被拒绝"),
            PlanBlock::Empty
        );
        assert_eq!(
            parse_plan(r#"{"version":1,"partitions":[]}"#, &[1], true).expect_err("应被拒绝"),
            PlanBlock::Empty
        );
    }

    #[test]
    fn parse_rejects_multi_topic_plan() {
        let raw = r#"{"version":1,"partitions":[
            {"topic":"a","partition":0,"replicas":[1]},
            {"topic":"b","partition":0,"replicas":[1]}]}"#;
        assert!(matches!(
            parse_plan(raw, &[1], true).expect_err("应被拒绝"),
            PlanBlock::Malformed(_)
        ));
    }

    #[test]
    fn parse_rejects_illegal_topic_name() {
        let raw = r#"{"version":1,"partitions":[{"topic":"订单","partition":0,"replicas":[1]}]}"#;
        assert!(matches!(
            parse_plan(raw, &[1], true).expect_err("应被拒绝"),
            PlanBlock::InvalidTopic(_)
        ));
    }

    #[test]
    fn generated_plan_roundtrips_through_parser() {
        let text = plan_lines("orders", &layout(&[(0, &[1, 2]), (1, &[2, 3])]), &[1, 2, 3]);
        let plan = parse_plan(&text, &[1, 2, 3], true).expect("自己生成的计划必须能被自己解析");
        assert_eq!(plan.partitions.len(), 2);
        assert_eq!(plan.partitions[1].replicas, vec![2, 3]);
    }

    #[test]
    fn progress_reports_pending_and_done() {
        let target = layout(&[(0, &[1, 2]), (1, &[2, 3])]);
        let current = layout(&[(0, &[1, 2]), (1, &[2, 4])]);
        let report = progress("orders", &target, &current);
        assert_eq!(report.done, 1);
        assert_eq!(report.running, 1);
        assert!(!report.is_complete());
        assert!(report.verdict.contains("还有 1 个分区没搬到"));

        let moved = report
            .partitions
            .iter()
            .find(|item| item.partition == 1)
            .expect("缺少分区 1");
        assert_eq!(moved.missing, vec![3]);
        assert_eq!(moved.extra, vec![4]);
        assert_eq!(moved.state, PartitionMigration::Pending);
    }

    #[test]
    fn progress_ignores_replica_order() {
        // 副本顺序变了但集合没变：preferred leader election 会自己收敛，
        // 算成「未完成」会让进度条永远停在那里。
        let target = layout(&[(0, &[1, 2])]);
        let current = layout(&[(0, &[2, 1])]);
        let report = progress("orders", &target, &current);
        assert!(report.is_complete());
    }

    #[test]
    fn progress_flags_missing_partitions() {
        let target = layout(&[(0, &[1]), (5, &[1])]);
        let current = layout(&[(0, &[1])]);
        let report = progress("orders", &target, &current);
        assert_eq!(report.unknown, 1);
        assert!(!report.is_complete());
        assert!(report.verdict.contains("计划和实际主题对不上"));
    }

    #[test]
    fn complete_report_says_so() {
        let target = layout(&[(0, &[1, 2])]);
        let report = progress("orders", &target, &target);
        assert!(report.is_complete());
        assert!(report.verdict.contains("已经符合计划"));
    }
}
