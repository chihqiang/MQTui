//! RabbitMQ 节点运行时指标。
//!
//! 节点表格里最容易骗人的是两个数字：**内存**和**磁盘**。
//! 管理 API 给的是绝对值，但「用了 2G」这件事在本机开发机上很糟、
//! 在 64G 的机器上很闲。所以这里同时保留绝对值和占比，判读一律按占比走。
//!
//! 阈值用的是 RabbitMQ 自己的默认水位（内存 60%、磁盘下限 50MB 之外的告警带），
//! 但**不复制服务端的水位配置**：面板看不到 `vm_memory_high_watermark`，
//! 所以阈值只做「提醒」用，不做「断言即将阻塞」用。措辞上必须守住这条线。

use serde::{Deserialize, Serialize};

/// 单个节点的运行时指标。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStat {
    pub name: String,
    pub running: bool,
    /// 已用内存（字节）。
    pub mem_used: u64,
    /// 内存上限（字节）。老版本管理 API 不报这个字段，此时为 0，占比按 `None` 处理。
    pub mem_limit: u64,
    /// 磁盘剩余（字节）。
    pub disk_free: u64,
    /// 磁盘告警下限（字节）。
    pub disk_limit: u64,
    /// 文件描述符已用 / 上限。
    pub fd_used: u64,
    pub fd_total: u64,
    pub sockets_used: u64,
    pub sockets_total: u64,
    /// Erlang 进程数，排查消息堆积时的第一个可疑对象。
    pub proc_used: u64,
    pub proc_total: u64,
    /// 当前是否处于 `alarm`（内存 / 磁盘水位已触发，会阻塞发布方）。
    pub alarm: bool,
}

impl NodeStat {
    /// 内存占用比例。缺少上限时返回 `None` —— 前端必须显示「未知」而不是 0%。
    pub fn mem_ratio(&self) -> Option<f64> {
        (self.mem_limit > 0).then(|| self.mem_used as f64 / self.mem_limit as f64)
    }

    /// 文件描述符占用比例。
    pub fn fd_ratio(&self) -> Option<f64> {
        (self.fd_total > 0).then(|| self.fd_used as f64 / self.fd_total as f64)
    }

    /// 磁盘是否已经低于告警下限。
    ///
    /// 只在服务端报了 `disk_limit` 时才判：不知道下限就不能说「快满了」，
    /// 那只是猜。`alarm` 字段由服务端给出，优先级更高。
    pub fn disk_low(&self) -> bool {
        self.disk_limit > 0 && self.disk_free < self.disk_limit
    }

    /// 内存是否进入告警带（≥ 80% 上限）。
    pub fn mem_high(&self) -> bool {
        self.mem_ratio().is_some_and(|ratio| ratio >= 0.8)
    }

    /// 该节点是否需要人工介入。
    pub fn needs_attention(&self) -> bool {
        self.alarm || self.disk_low() || self.mem_high()
    }
}

/// 一个节点的一句话结论，界面上直接显示，不在前端拼中文。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeVerdict {
    pub name: String,
    /// 简短结论，例如「内存水位已触发」。
    pub headline: String,
    /// 补充说明，可以为空。
    pub detail: String,
    /// 是否需要人工介入。
    pub attention: bool,
}

/// 内存告警带的下限。
///
/// 80% 不是 RabbitMQ 的默认水位（默认 60%），而是「明显偏紧」的观察线：
/// 面板不该假装知道服务端的水位配置，也不该等到服务端已经阻塞了才提醒。
const MEM_WARN_RATIO: f64 = 0.8;

/// 给每个节点产出结论。
pub fn verdicts(stats: &[NodeStat]) -> Vec<NodeVerdict> {
    stats.iter().map(verdict).collect()
}

fn verdict(stat: &NodeStat) -> NodeVerdict {
    if !stat.running {
        return NodeVerdict {
            name: stat.name.clone(),
            headline: "节点未运行".to_owned(),
            detail: "该节点当前不提供服务，它承载的经典队列会不可用".to_owned(),
            attention: true,
        };
    }

    if stat.alarm {
        return NodeVerdict {
            name: stat.name.clone(),
            headline: "水位告警已触发".to_owned(),
            detail: "服务端已阻塞发布方，新消息会被拦下；请检查内存与磁盘占用".to_owned(),
            attention: true,
        };
    }

    if stat.disk_low() {
        return NodeVerdict {
            name: stat.name.clone(),
            headline: "磁盘低于告警下限".to_owned(),
            detail: format!(
                "剩余 {} 已低于下限 {}，再不处理服务端就会进入阻塞",
                human_bytes(stat.disk_free),
                human_bytes(stat.disk_limit)
            ),
            attention: true,
        };
    }

    if stat.mem_high() {
        let ratio = stat.mem_ratio().unwrap_or(0.0);
        return NodeVerdict {
            name: stat.name.clone(),
            headline: "内存偏紧".to_owned(),
            detail: format!(
                "已用上限的 {:.0}%（超过 {:.0}% 观察线）；服务端水位配置未知，暂不判定为阻塞",
                ratio * 100.0,
                MEM_WARN_RATIO * 100.0
            ),
            attention: true,
        };
    }

    NodeVerdict {
        name: stat.name.clone(),
        headline: "正常".to_owned(),
        detail: String::new(),
        attention: false,
    }
}

/// 字节数的可读形式。只用于补足说明文字，表格里的数值仍由前端格式化。
fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes}{}", UNITS[0])
    } else {
        format!("{value:.1}{}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat() -> NodeStat {
        NodeStat {
            name: "rabbit@n1".to_owned(),
            running: true,
            mem_used: 100,
            mem_limit: 1000,
            disk_free: 10_000,
            disk_limit: 1_000,
            fd_used: 10,
            fd_total: 100,
            sockets_used: 1,
            sockets_total: 10,
            proc_used: 100,
            proc_total: 1_000_000,
            alarm: false,
        }
    }

    #[test]
    fn healthy_node_has_no_attention() {
        let result = verdicts(&[stat()]);
        assert_eq!(result[0].headline, "正常");
        assert!(!result[0].attention);
    }

    #[test]
    fn stopped_node_wins_over_every_other_signal() {
        let mut node = stat();
        node.running = false;
        node.alarm = true;
        let result = verdict(&node);
        assert_eq!(result.headline, "节点未运行");
    }

    #[test]
    fn server_alarm_outranks_local_guesswork() {
        let mut node = stat();
        node.alarm = true;
        node.mem_used = 999;
        assert_eq!(verdict(&node).headline, "水位告警已触发");
    }

    #[test]
    fn missing_mem_limit_reports_unknown_ratio_instead_of_zero() {
        let mut node = stat();
        node.mem_limit = 0;
        assert!(node.mem_ratio().is_none());
        // 没有上限就不能说「内存偏紧」，即便绝对用量很大。
        node.mem_used = u64::MAX;
        assert_eq!(verdict(&node).headline, "正常");
    }

    #[test]
    fn low_disk_is_detected_only_when_limit_is_known() {
        let mut node = stat();
        node.disk_free = 500;
        assert!(node.disk_low());
        node.disk_limit = 0;
        assert!(!node.disk_low());
    }

    #[test]
    fn mem_warn_band_is_eighty_percent() {
        let mut node = stat();
        node.mem_used = 799;
        assert!(!node.mem_high());
        node.mem_used = 800;
        assert!(node.mem_high());
    }

    #[test]
    fn human_bytes_picks_readable_unit() {
        assert_eq!(human_bytes(512), "512B");
        assert_eq!(human_bytes(2048), "2.0KB");
        assert_eq!(human_bytes(3 * 1024 * 1024), "3.0MB");
    }
}
