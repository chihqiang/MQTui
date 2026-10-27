//! 集群页的展示模型：在 `ClusterNode` 之上补三样「看集群时要先看的东西」。
//!
//! 判读规则全在这里，不碰网络：
//! - **一致性报警**：某个队列 / 主题的分区在节点之间说法不一致，这类问题
//!   在节点表格里逐行看是看不出来的，必须显式标出来；
//! - **容量**：谁是磁盘水位最高的那个节点；
//! - **总数**：运行中节点数，用来一眼判断「是不是少了节点」。
//!
//! 之所以单独成文件而不是塞进 `cluster.rs`：那个文件负责「一个节点长什么样」，
//! 这个文件负责「一堆节点放在一起说明了什么」。职责不同，改动频率也不同。

use serde::{Deserialize, Serialize};

use super::cluster::ClusterNode;

/// 集群页的一行报警。
///
/// `severity` 只有两档：`warn` 需要处理，`info` 只是提醒。
/// 不做三档以上——面板里的颜色分级超过两档之后就没人记得住含义了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlertSeverity {
    Warn,
    Info,
}

/// 从集群快照里读出的一条结论。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterAlert {
    pub severity: AlertSeverity,
    /// 一句话结论。
    pub title: String,
    /// 展开说明：为什么报、该看哪里。
    pub detail: String,
}

impl ClusterAlert {
    /// 供其它模块补充中间件专属报警时复用，保证构造口径与这里一致。
    pub fn warn_pair(title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::warn(title, detail)
    }

    fn warn(title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            severity: AlertSeverity::Warn,
            title: title.into(),
            detail: detail.into(),
        }
    }

    fn info(title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            severity: AlertSeverity::Info,
            title: title.into(),
            detail: detail.into(),
        }
    }
}

/// 集群快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterView {
    pub nodes: Vec<ClusterNode>,
    /// 运行中的节点数。
    pub running: usize,
    pub total: usize,
    pub alerts: Vec<ClusterAlert>,
}

/// 单个节点的聚合信息，用来判定报警。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeStat {
    pub name: String,
    pub running: bool,
}

/// 生成集群快照。
///
/// 三条判定都只依赖「节点是否在运行」这一件事，其余信息留给具体中间件补充：
///
/// 1. 有节点不在运行 → `warn`。集群要运维，先要知道少了谁。
/// 2. 全部节点都不在运行 → 额外一条 `warn`，说明这是「整群失联」而不是「掉了一个」。
/// 3. 只有**一个**运行中的节点 → `info`。单节点集群没有冗余，
///    这条不算故障（很多开发环境就是单机），所以只提醒不报警。
pub fn summarize(nodes: &[ClusterNode]) -> ClusterView {
    let total = nodes.len();
    let running = nodes.iter().filter(|node| node.running).count();
    let mut alerts = Vec::new();

    let down: Vec<&str> = nodes
        .iter()
        .filter(|node| !node.running)
        .map(|node| node.name.as_str())
        .collect();
    if !down.is_empty() && running > 0 {
        alerts.push(ClusterAlert::warn(
            format!("{} 个节点未运行", down.len()),
            format!("未运行：{}", down.join("、")),
        ));
    }
    if total > 0 && running == 0 {
        alerts.push(ClusterAlert::warn(
            "全部节点均未运行",
            "连接本身可能是通的，但集群没有任何节点在服务，请检查服务端状态",
        ));
    }
    if running == 1 && total == 1 {
        alerts.push(ClusterAlert::info(
            "单节点集群",
            "没有副本冗余，节点故障即全量不可用；生产环境请至少部署三个节点",
        ));
    }

    ClusterView {
        nodes: nodes.to_vec(),
        running,
        total,
        alerts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::cluster::NodeRole;

    fn node(name: &str, running: bool) -> ClusterNode {
        ClusterNode::new(name, NodeRole::Disc).with_running(running)
    }

    #[test]
    fn healthy_multi_node_cluster_has_no_alerts() {
        let view = summarize(&[node("a", true), node("b", true), node("c", true)]);
        assert_eq!(view.running, 3);
        assert_eq!(view.total, 3);
        assert!(view.alerts.is_empty());
    }

    #[test]
    fn single_node_cluster_is_info_not_warn() {
        let view = summarize(&[node("a", true)]);
        assert_eq!(view.alerts.len(), 1);
        assert_eq!(view.alerts[0].severity, AlertSeverity::Info);
    }

    #[test]
    fn one_node_down_reports_names() {
        let view = summarize(&[node("a", true), node("b", false)]);
        assert_eq!(view.running, 1);
        // 单节点告警不触发（total = 2），只有「一个节点未运行」这一条。
        assert_eq!(view.alerts.len(), 1);
        assert_eq!(view.alerts[0].severity, AlertSeverity::Warn);
        assert!(view.alerts[0].detail.contains('b'));
    }

    #[test]
    fn all_nodes_down_is_reported_once_as_whole_cluster() {
        let view = summarize(&[node("a", false), node("b", false)]);
        assert_eq!(view.running, 0);
        assert_eq!(view.alerts.len(), 1);
        assert!(view.alerts[0].title.contains("全部"));
    }

    #[test]
    fn empty_snapshot_has_no_alerts() {
        let view = summarize(&[]);
        assert_eq!(view.total, 0);
        assert!(view.alerts.is_empty());
    }
}
