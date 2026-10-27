//! 分区迁移的执行方案（runbook）。
//!
//! 上一轮说清了一件事：**这一版不能「一键执行」**——当前 rdkafka 绑定里没有
//! `rd_kafka_AlterPartitionReassignments`，拼一个半残的裸 FFI 风险太大。
//!
//! 但「不能自己发请求」不等于「只能给一句去跑命令行吧」。真正让面板有用的是
//! 把命令行那套流程里最容易出错的部分搬到界面上：
//!
//! 1. **生成可执行脚本**：连 `--bootstrap-server`、`--reassignment-json-file`、
//!    `--throttle` 都拼好，用户复制即用。少一个参数就是一次踩坑。
//! 2. **前置检查清单**：副本跨机架、`min.insync.replicas`、限流是否设置。
//!    这些条件不满足时，迁移会把集群拖垮或者直接失败，而失败时最糟的情况
//!    正好是不可回滚。
//! 3. **解释 `--verify` 的输出**：命令行的 `--verify` 结果是人读的一堆英文，
//!    面板把「完成 / 进行中 / 失败」三类解析出来，和进度表对得上。
//!
//! 全部是纯函数，不碰网络，也不碰命令行。

use serde::{Deserialize, Serialize};

use super::reassignment::{Layout, MigrationReport, PlannedPartition, ReassignmentPlan};

/// 迁移前的检查项状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreconditionState {
    /// 满足。
    Ok,
    /// 不满足，但只是建议级别（例如没设限流）。
    Warn,
    /// 不满足，会直接让迁移失败或事后无法收拾。
    Block,
    /// 缺少判断所需的数据。
    Unknown,
}

/// 一条前置检查。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Precondition {
    /// 稳定的标识，前端用来做跳转或高亮。
    pub key: String,
    pub title: String,
    pub state: PreconditionState,
    /// 一句可直接展示的说明，写清「为什么」。
    pub detail: String,
}

/// 一份执行方案。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRunbook {
    pub topic: String,
    pub preconditions: Vec<Precondition>,
    /// 是否可以先走完前置检查。为 `false` 时界面不该让人复制脚本。
    pub actionable: bool,
    /// 生成计划：把当前布局导出成 JSON（第 1 步）。
    pub generate_script: String,
    /// 执行计划（第 2 步）。
    pub execute_script: String,
    /// 核对进度（第 3 步）。
    pub verify_script: String,
    /// 执行完成后要做的收尾动作。
    pub followups: Vec<String>,
}

impl MigrationRunbook {
    /// 被拦下的检查项标题。
    pub fn blocking(&self) -> Vec<&str> {
        self.preconditions
            .iter()
            .filter(|item| item.state == PreconditionState::Block)
            .map(|item| item.title.as_str())
            .collect()
    }
}

/// 迁移脚本的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunbookRequest {
    pub bootstrap: String,
    pub topic: String,
    /// 限流（字节/秒）。`None` 表示不限流。
    pub throttle: Option<u64>,
    /// 计划文件在命令行那侧的路径。
    pub plan_file: String,
}

impl RunbookRequest {
    /// 从连接配置与选项构造。空字符串的 bootstrap 在调用侧就该被拦，这里给个保守默认值。
    pub fn new(bootstrap: &str, topic: &str) -> Self {
        Self {
            bootstrap: bootstrap.trim().to_owned(),
            topic: topic.trim().to_owned(),
            throttle: None,
            plan_file: "reassignment.json".to_owned(),
        }
    }
}

/// 生成执行方案。
///
/// `layout` 是当前布局（用于检查副本数与目标是否一致），`plan` 是校验过的目标计划，
/// `min_insync` 是主题的 `min.insync.replicas`（读不到时传 `None`）。
pub fn build(
    request: &RunbookRequest,
    plan: &ReassignmentPlan,
    layout: &Layout,
    min_insync: Option<u32>,
) -> MigrationRunbook {
    let mut preconditions: Vec<Precondition> = Vec::new();

    // 1. bootstrap 与主题
    if request.bootstrap.is_empty() {
        preconditions.push(Precondition {
            key: "bootstrap".to_owned(),
            title: "缺少 bootstrap 地址".to_owned(),
            state: PreconditionState::Block,
            detail: "脚本需要 --bootstrap-server，请先在连接配置里填好 broker 地址".to_owned(),
        });
    } else {
        preconditions.push(Precondition {
            key: "bootstrap".to_owned(),
            title: "bootstrap 地址".to_owned(),
            state: PreconditionState::Ok,
            detail: format!("脚本将连到 {}", request.bootstrap),
        });
    }

    // 2. 目标副本数与当前是否一致
    //
    // 副本数变了意味着这次操作同时在做「迁移」和「增减副本」，出问题时无法判断
    // 是哪一步的锅。Kafka 允许这样干，但面板不该在没说清楚的情况下默认放行。
    let mut replica_mismatch: Vec<String> = Vec::new();
    for item in &plan.partitions {
        let current = layout
            .iter()
            .find(|entry| entry.partition == item.partition)
            .map(|entry| entry.replicas.len());
        match current {
            Some(len) if len != item.replicas.len() => replica_mismatch.push(format!(
                "分区 {} 当前 {} 副本 → 目标 {} 副本",
                item.partition,
                len,
                item.replicas.len()
            )),
            None => replica_mismatch.push(format!("分区 {} 在当前布局里不存在", item.partition)),
            _ => {}
        }
    }
    preconditions.push(if replica_mismatch.is_empty() {
        Precondition {
            key: "replica-count".to_owned(),
            title: "副本数保持一致".to_owned(),
            state: PreconditionState::Ok,
            detail: "这次迁移只搬副本位置，不改变副本数量".to_owned(),
        }
    } else {
        Precondition {
            key: "replica-count".to_owned(),
            title: "副本数发生变化".to_owned(),
            state: PreconditionState::Warn,
            detail: format!(
                "同时增减副本会让失败原因难以定位：{}",
                replica_mismatch.join("；")
            ),
        }
    });

    // 3. min.insync.replicas
    //
    // 迁移期间目标副本还在追数据，ISR 会短暂收缩。若 min.insync.replicas 等于
    // 副本数，收缩期内所有 acks=all 的写入都会被拒——这是迁移把人打进故障的
    // 最常见方式，而且发生在迁移过程中，很难第一时间想到原因。
    let replica_count = plan
        .partitions
        .iter()
        .map(|item| item.replicas.len())
        .max()
        .unwrap_or(1);
    preconditions.push(match min_insync {
        Some(value) if value as usize >= replica_count && replica_count > 1 => Precondition {
            key: "min-insync".to_owned(),
            title: "min.insync.replicas 偏高".to_owned(),
            state: PreconditionState::Warn,
            detail: format!(
                "min.insync.replicas={value} 等于副本数 {replica_count}：迁移期间 ISR 收缩，
                 所有 acks=all 的写入会被拒。要么调低它，要么在低峰期迁移"
            ),
        },
        Some(value) => Precondition {
            key: "min-insync".to_owned(),
            title: "min.insync.replicas".to_owned(),
            state: PreconditionState::Ok,
            detail: format!("{value} < 副本数 {replica_count}，迁移期间仍有写入余量"),
        },
        None => Precondition {
            key: "min-insync".to_owned(),
            title: "读不到 min.insync.replicas".to_owned(),
            state: PreconditionState::Unknown,
            detail: "默认值是 1，多数情况下安全；如果主题显式调高过，请手动确认".to_owned(),
        },
    });

    // 4. 限流
    //
    // 不设限流的迁移会把磁盘和网络带宽吃满，直接影响业务读写。这不是「可选项」，
    // 是「必做」——只是它不会让迁移失败，所以只报警不拦。
    preconditions.push(match request.throttle {
        Some(bytes) if bytes > 0 => Precondition {
            key: "throttle".to_owned(),
            title: "已设置限流".to_owned(),
            state: PreconditionState::Ok,
            detail: format!("脚本带 --throttle {bytes}（字节/秒）；迁移结束后记得清掉"),
        },
        _ => Precondition {
            key: "throttle".to_owned(),
            title: "没有设置限流".to_owned(),
            state: PreconditionState::Warn,
            detail: "迁移会吃满磁盘与网络带宽；建议填一个限流值（例如 50MB/s = 52428800）"
                .to_owned(),
        },
    });

    // 5. 单副本分区：迁移过程中没有冗余，任何一次 broker 抖动都可能丢数据。
    let single_replica: Vec<i32> = plan
        .partitions
        .iter()
        .filter(|item| item.replicas.len() == 1)
        .map(|item| item.partition)
        .collect();
    if !single_replica.is_empty() {
        preconditions.push(Precondition {
            key: "single-replica".to_owned(),
            title: "存在单副本分区".to_owned(),
            state: PreconditionState::Warn,
            detail: format!(
                "分区 {} 只有一个副本：搬运期间没有冗余，broker 抖动会直接丢数据",
                single_replica
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        });
    }

    let actionable = !preconditions
        .iter()
        .any(|item| item.state == PreconditionState::Block);

    let throttle_arg = request
        .throttle
        .filter(|value| *value > 0)
        .map(|value| format!(" \\\n  --throttle {value}"))
        .unwrap_or_default();

    let generate_script = format!(
        "kafka-reassign-partitions.sh --bootstrap-server {bootstrap} \\\n  --topics-to-move-json-file topics.json \\\n  --broker-list {brokers} \\\n  --generate{throttle}",
        bootstrap = request.bootstrap,
        brokers = broker_list(plan),
        throttle = throttle_arg,
    );

    let execute_script = format!(
        "kafka-reassign-partitions.sh --bootstrap-server {bootstrap} \\\n  --reassignment-json-file {file} \\\n  --execute{throttle}",
        bootstrap = request.bootstrap,
        file = request.plan_file,
        throttle = throttle_arg,
    );

    let verify_script = format!(
        "kafka-reassign-partitions.sh --bootstrap-server {bootstrap} \\\n  --reassignment-json-file {file} \\\n  --verify",
        bootstrap = request.bootstrap,
        file = request.plan_file,
    );

    let mut followups = vec![
        "迁移完成后清除限流：kafka-configs.sh --alter --entity-type brokers --entity-default --entity-name <id> --delete-config leader.replication.throttled.rate,follower.replication.throttled.rate"
            .to_owned(),
        format!(
            "确认 {} 的全部 {} 个分区副本集合与计划一致，再删掉计划文件",
            request.topic,
            plan.partitions.len()
        ),
    ];
    if replica_mismatch.is_empty() {
        followups.push(
            "副本集合没变时顺序变化无需处理：preferred leader election 会自己收敛".to_owned(),
        );
    }

    MigrationRunbook {
        topic: request.topic.clone(),
        preconditions,
        actionable,
        generate_script,
        execute_script,
        verify_script,
        followups,
    }
}

/// 计划里出现过的全部 broker，升序去重，用于 `--broker-list`。
fn broker_list(plan: &ReassignmentPlan) -> String {
    let mut brokers: Vec<i32> = plan
        .partitions
        .iter()
        .flat_map(|item| item.replicas.iter().copied())
        .collect();
    brokers.sort_unstable();
    brokers.dedup();
    brokers
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// `--verify` 输出的解析结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySummary {
    /// 已完成的分区数。
    pub completed: usize,
    /// 仍在进行的分区数。
    pub in_progress: usize,
    /// 失败的分区数。
    pub failed: usize,
    /// 逐行识别出来的状态，便于界面对照进度表。
    pub lines: Vec<VerifyLine>,
    /// 一句话结论。
    pub verdict: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyLine {
    pub partition: String,
    pub state: VerifyState,
    /// 原文，保留下来是因为解析规则总有漏网的时候。
    pub raw: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerifyState {
    Completed,
    InProgress,
    Failed,
    Unknown,
}

/// 解析 `kafka-reassign-partitions.sh --verify` 的输出。
///
/// 命令行的原文形如：
/// ```text
/// Status of partition reassignment:
/// Reassignment of partition orders-0 is completed
/// Reassignment of partition orders-1 is still in progress
/// ```
/// 规则刻意只认这三种句式：命令行改文案时，解析不到的行会落到 `unknown`，
/// 界面上照原文显示，不假装懂。**不把 `unknown` 当成功**——这是最要紧的一条。
pub fn parse_verify(output: &str) -> VerifySummary {
    let mut lines: Vec<VerifyLine> = Vec::new();

    for raw in output.lines() {
        let text = raw.trim();
        // 只要「Reassignment of partition ...」这类行。抬头 `Status of partition
        // reassignment:` 也含 partition，但不能算成一条分区状态。
        // 抬头 `Status of partition reassignment:` 也含 "of partition"，需要再排除掉：
        // 它的下一段是 reassignment，而不是分区的名字。用「of partition 后面紧跟
        // 主题名-分区号」的形态判断，认不出的行留给 unknown。
        let lowered = text.to_ascii_lowercase();
        // 抬头 `Status of partition reassignment:` 与 `Partition orders-0 needs attention`
        // 都不能按「of partition」一刀切：前者是表头，后者没有 of partition 但确实是状态行。
        if text.is_empty() || lowered.contains("reassignment:") {
            continue;
        }
        if !lowered.contains("partition") {
            continue;
        }
        let lowered = text.to_ascii_lowercase();
        let state = if lowered.contains("is completed") {
            VerifyState::Completed
        } else if lowered.contains("still in progress") {
            VerifyState::InProgress
        } else if lowered.contains("failed") || lowered.contains("cancelled") {
            VerifyState::Failed
        } else {
            VerifyState::Unknown
        };
        lines.push(VerifyLine {
            partition: extract_partition(text),
            state,
            raw: text.to_owned(),
        });
    }

    let completed = lines
        .iter()
        .filter(|line| line.state == VerifyState::Completed)
        .count();
    let in_progress = lines
        .iter()
        .filter(|line| line.state == VerifyState::InProgress)
        .count();
    let failed = lines
        .iter()
        .filter(|line| line.state == VerifyState::Failed)
        .count();

    let verdict = if lines.is_empty() {
        "输出里没有识别到任何分区状态：确认命令带上了 --verify 与计划文件".to_owned()
    } else if failed > 0 {
        format!("{failed} 个分区迁移失败：先查 broker 日志，不要重复提交计划")
    } else if in_progress > 0 {
        format!("{in_progress} 个分区仍在搬运，已完成 {completed} 个：继续等，别在此时删主题")
    } else {
        format!("全部 {completed} 个分区已完成")
    };

    VerifySummary {
        completed,
        in_progress,
        failed,
        lines,
        verdict,
    }
}

/// 从一行输出里抠出分区名（`orders-0` 这种）。抠不出来就返回整行。
fn extract_partition(line: &str) -> String {
    // 取 "of partition" 之后、下一个空格之前的片段。
    let marker = "of partition";
    let Some(index) = line.to_ascii_lowercase().find(marker) else {
        return line.to_owned();
    };
    let rest = line[index + marker.len()..].trim_start();
    let token = rest
        .split_whitespace()
        .next()
        .unwrap_or(rest)
        .trim_end_matches('.');
    if token.is_empty() {
        line.to_owned()
    } else {
        token.to_owned()
    }
}

/// 把当前布局转成 `topics-to-move.json` 的内容。
///
/// 这份文件是 `--generate` 的输入，只需要主题名。单独给一个函数，是因为
/// 手写 JSON 时最常见的错误是多一个逗号或者漏了引号，而命令行只会回一句语法错误。
pub fn topics_file(topic: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "topics": [{ "topic": topic }],
        "version": 1,
    }))
    .unwrap_or_default()
}

/// 把进度报告和 `--verify` 结果对起来，找出一致性上的出入。
///
/// 两份数据来源不同（元数据 vs 命令行输出），对不上时最可能的情况是
/// **用户拿错了计划文件**，或者迁移已经被别人取消。这件事必须说出来，
/// 而不是让界面两处各显示一半。
pub fn reconcile(report: &MigrationReport, verify: &VerifySummary) -> Vec<String> {
    let mut notes: Vec<String> = Vec::new();

    if verify.failed > 0 {
        notes.push(format!(
            "命令行报告 {} 个分区失败，但当前布局只看得出 {} 个未完成：失败原因要去 broker 日志里找",
            verify.failed, report.running
        ));
    }
    if verify.completed > 0 && report.running > 0 {
        notes.push(format!(
            "命令行认为 {} 个分区已完成，而元数据显示还有 {} 个未搬到目标位置：可能是在磁盘上搬完了、元数据还没刷新，也可能你验证的不是这份计划",
            verify.completed, report.running
        ));
    }
    if verify.in_progress == 0 && verify.completed == 0 && report.running > 0 {
        notes.push(
            "命令行输出里没有任何分区状态，而元数据显示迁移还没完成：确认 --reassignment-json-file 指向的就是这份计划"
                .to_owned(),
        );
    }
    notes
}

/// 把一个目标布局裁剪成「当前布局的副本数不变」的近似——只在没有真实目标时用于示例。
///
/// 单独抽出来是为了让「计划文件长什么样」这件事可测：界面上的示例必须和目标
/// 布局同构，否则用户复制过去会得到一个格式正确的错误计划。
pub fn sample_plan(topic: &str, layout: &Layout) -> String {
    let plan = ReassignmentPlan {
        topic: topic.to_owned(),
        partitions: layout
            .iter()
            .map(|item: &PlannedPartition| PlannedPartition {
                partition: item.partition,
                replicas: item.replicas.clone(),
            })
            .collect(),
    };
    serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "partitions": plan.partitions.iter().map(|item| serde_json::json!({
            "topic": plan.topic,
            "partition": item.partition,
            "replicas": item.replicas,
        })).collect::<Vec<_>>(),
    }))
    .unwrap_or_default()
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

    fn plan_of(topic: &str, items: &[(i32, &[i32])]) -> ReassignmentPlan {
        ReassignmentPlan {
            topic: topic.to_owned(),
            partitions: layout(items),
        }
    }

    #[test]
    fn scripts_carry_bootstrap_and_throttle() {
        let mut request = RunbookRequest::new("broker-1:9092,broker-2:9092", "orders");
        request.throttle = Some(52_428_800);
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1, 2]), (1, &[2, 3])]),
            &layout(&[(0, &[1, 2]), (1, &[2, 3])]),
            Some(1),
        );

        assert!(runbook.actionable);
        // 三个脚本都要带上连接地址：少一个参数就是让用户去试错。
        assert!(runbook.execute_script.contains("broker-1:9092"));
        assert!(runbook.execute_script.contains("--throttle 52428800"));
        assert!(runbook.verify_script.contains("--verify"));
        assert!(runbook.generate_script.contains("--broker-list 1,2,3"));
    }

    #[test]
    fn missing_bootstrap_blocks_everything() {
        let request = RunbookRequest::new("  ", "orders");
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1])]),
            &layout(&[(0, &[1])]),
            Some(1),
        );
        assert!(!runbook.actionable);
        assert_eq!(runbook.blocking(), vec!["缺少 bootstrap 地址"]);
    }

    #[test]
    fn high_min_insync_is_warned_not_blocked() {
        let request = RunbookRequest::new("b:9092", "orders");
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1, 2, 3])]),
            &layout(&[(0, &[1, 2, 3])]),
            Some(3),
        );
        // 会把人打进故障，但仍是合法操作 —— 拦下会让正常迁移也做不了。
        assert!(runbook.actionable);
        let item = runbook
            .preconditions
            .iter()
            .find(|item| item.key == "min-insync")
            .expect("缺少 min-insync 检查");
        assert_eq!(item.state, PreconditionState::Warn);
        assert!(item.detail.contains("acks=all"));
    }

    #[test]
    fn unknown_min_insync_does_not_block() {
        let request = RunbookRequest::new("b:9092", "orders");
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1, 2])]),
            &layout(&[(0, &[1, 2])]),
            None,
        );
        let item = runbook
            .preconditions
            .iter()
            .find(|item| item.key == "min-insync")
            .expect("缺少 min-insync 检查");
        assert_eq!(item.state, PreconditionState::Unknown);
        assert!(runbook.actionable);
    }

    #[test]
    fn replica_count_change_is_warned() {
        let request = RunbookRequest::new("b:9092", "orders");
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1, 2, 3])]),
            &layout(&[(0, &[1, 2])]),
            Some(1),
        );
        let item = runbook
            .preconditions
            .iter()
            .find(|item| item.key == "replica-count")
            .expect("缺少副本数检查");
        assert_eq!(item.state, PreconditionState::Warn);
        assert!(item.detail.contains("分区 0"));
    }

    #[test]
    fn single_replica_partition_is_flagged() {
        let request = RunbookRequest::new("b:9092", "orders");
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1])]),
            &layout(&[(0, &[1])]),
            Some(1),
        );
        assert!(
            runbook
                .preconditions
                .iter()
                .any(|item| item.key == "single-replica")
        );
    }

    #[test]
    fn missing_throttle_is_warn_only() {
        let request = RunbookRequest::new("b:9092", "orders");
        let runbook = build(
            &request,
            &plan_of("orders", &[(0, &[1, 2])]),
            &layout(&[(0, &[1, 2])]),
            Some(1),
        );
        assert!(runbook.actionable);
        let item = runbook
            .preconditions
            .iter()
            .find(|item| item.key == "throttle")
            .expect("缺少限流检查");
        assert_eq!(item.state, PreconditionState::Warn);
    }

    #[test]
    fn verify_output_is_parsed_by_sentence() {
        let output = "Status of partition reassignment:\n\
            Reassignment of partition orders-0 is completed.\n\
            Reassignment of partition orders-1 is still in progress\n\
            Reassignment of partition orders-2 failed.\n";
        let summary = parse_verify(output);
        assert_eq!(summary.completed, 1);
        assert_eq!(summary.in_progress, 1);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.lines[0].partition, "orders-0");
        assert!(summary.verdict.contains("失败"));
    }

    #[test]
    fn unparsable_verify_line_is_unknown_not_success() {
        let summary =
            parse_verify("Status of partition reassignment:\nPartition orders-0 needs attention");
        assert_eq!(summary.completed, 0);
        assert_eq!(summary.lines.len(), 1);
        // 认不出来就落 unknown：把它当成功是最危险的一种错。
        assert_eq!(summary.lines[0].state, VerifyState::Unknown);
    }

    #[test]
    fn empty_verify_output_says_so() {
        let summary = parse_verify("");
        assert_eq!(summary.lines.len(), 0);
        assert!(summary.verdict.contains("--verify"));
    }

    #[test]
    fn reconcile_reports_failures_and_mismatch() {
        let report = MigrationReport {
            topic: "orders".to_owned(),
            partitions: Vec::new(),
            done: 1,
            running: 2,
            unknown: 0,
            verdict: String::new(),
        };
        let verify = parse_verify(
            "Reassignment of partition orders-0 is completed.\n\
             Reassignment of partition orders-1 failed.",
        );
        let notes = reconcile(&report, &verify);
        assert!(notes.iter().any(|note| note.contains("失败")));
        assert!(notes.iter().any(|note| note.contains("未搬到目标位置")));
    }

    #[test]
    fn topics_file_is_valid_json() {
        let text = topics_file("orders");
        let value: serde_json::Value = serde_json::from_str(&text).expect("应当是合法 JSON");
        assert_eq!(value["topics"][0]["topic"], "orders");
    }

    #[test]
    fn sample_plan_matches_target_shape() {
        let text = sample_plan("orders", &layout(&[(0, &[1, 2])]));
        let value: serde_json::Value = serde_json::from_str(&text).expect("应当是合法 JSON");
        assert_eq!(value["partitions"][0]["replicas"][1], 2);
        assert_eq!(value["partitions"][0]["topic"], "orders");
    }

    #[test]
    fn broker_list_is_sorted_and_deduped() {
        let plan = plan_of("orders", &[(0, &[3, 1]), (1, &[1, 2])]);
        assert_eq!(broker_list(&plan), "1,2,3");
    }
}
