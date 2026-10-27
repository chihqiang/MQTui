//! 铲子（shovel）的运行态：它现在搬不搬、卡在哪。
//!
//! 参数页只管「配置」：`/api/parameters/shovel/{vhost}/{name}` 存的是一段 JSON。
//! 但那段 JSON **是否真的在跑**，参数接口一个字都不说 —— 删掉 shovel 插件、
//! `src-uri` 连不上、上游节点挂了、名字拼错了前缀，四种情况的参数看起来
//! 完全一样：一条正常保存的配置。
//!
//! 运行态在另一个接口：`GET /api/shovels`。所以这一层做的是「把两个接口对起来」：
//! 配置是「打算搬」，运行态是「正在搬」，缺一个就得说清缺的是哪一半。
//!
//! 三个主要判读：
//!
//! 1. **配置在、状态不在**：插件没启用 / 还没起来 / 名字不匹配。这是最常见的
//!    「我明明配了就是不搬」，界面必须点出来，而不是让用户去翻日志；
//! 2. **状态是 `terminated`**：铲子进程已经退出，错误信息在 `reason` 里。
//!    它不会自动重启，配置看着好好的，消息却不动；
//! 3. **状态在、配置不在**：运行态是按 vhost 拉的，但当前连接只连了一个 vhost，
//!    别的 vhost 的铲子也会出现在结果里。这类要在页面上标出「配置不在本 vhost」，
//!    否则会让人以为「这条铲子没有配置却还在跑」。
//!
//! 规则全是纯函数，不碰网络，可单测。前端对应 `src/lib/shovel.ts`。

use serde::{Deserialize, Serialize};

use super::parameter::{ParameterComponent, ParameterInfo, redact_uri};

/// 铲子的运行状态。取值就是管理 API `state` 字段的原文。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShovelState {
    /// 正在搬。
    Running,
    /// 正在启动（建立连接）。
    Starting,
    /// 已停止：手动停的，或到了 `src-delete-after` 的终点。
    Terminated,
}

impl ShovelState {
    /// 这个状态算不算「消息在动」。
    pub const fn is_moving(self) -> bool {
        matches!(self, Self::Running)
    }

    /// 这是不是一次「本该在搬却停了」。`starting` 不算：它可能只是刚开始。
    pub const fn is_stopped(self) -> bool {
        matches!(self, Self::Terminated)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Running => "运行中",
            Self::Starting => "启动中",
            Self::Terminated => "已停止",
        }
    }
}

/// 运行态里的一行。字段按「排查时先看哪个」排列。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShovelRuntime {
    pub name: String,
    pub vhost: String,
    pub state: ShovelState,
    /// 类型：`static`（配置里声明的）或 `dynamic`（运行中通过 API 起的）。
    pub kind: String,
    /// 失败原因或停止原因。空串表示没给。
    pub reason: String,
    /// 源 / 目标地址，**已打码**。运行态的这个字段比配置里的更可信：
    /// 配置改了但没重启时，这里显示的是它真正在连的地址。
    pub src_uri: String,
    pub dest_uri: String,
    /// 累计搬运的条数。它是「有没有真的搬过东西」的唯一证据。
    pub messages_transferred: u64,
}

impl ShovelRuntime {
    /// 列表里的一行摘要：先看「搬了多少」，再看有没有报错。
    pub fn summary(&self) -> String {
        let mut parts = vec![format!("{} 条", self.messages_transferred)];
        let src = redact_uri(&self.src_uri);
        let dest = redact_uri(&self.dest_uri);
        if !src.is_empty() && !dest.is_empty() {
            parts.push(format!("{src} → {dest}"));
        }
        if !self.reason.trim().is_empty() {
            parts.push(format!("原因：{}", self.reason.trim()));
        }
        parts.join(" · ")
    }
}

/// 一条铲子的合并结论：配置与运行态各占一半。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShovelRow {
    pub name: String,
    pub vhost: String,
    /// 配置存在的话，那一行参数（`value` 原样保留）。
    pub config: Option<ParameterInfo>,
    /// 运行态存在的话，那一行状态。
    pub runtime: Option<ShovelRuntime>,
    /// 为什么这条「看着正常但不动」。空串表示没发现问题。
    ///
    /// 这个字段和「界面上的红字」是一回事，但判断只能在这里做：
    /// 前端拿到两个 `null` 是没法区分「插件没装」和「名字写错了」的。
    pub problem: String,
    /// 这条铲子不该被当成「当前 vhost 的配置」。运行态里别的 vhost 的铲子会一起出现，
    /// 而配置是按连接所在的 vhost 拉的，配对不上是常态。
    pub foreign: bool,
}

impl ShovelRow {
    /// 是否值得让人停下来看一眼。`starting` 不算：它可能只是刚起。
    pub fn needs_attention(&self) -> bool {
        !self.problem.trim().is_empty()
            || self
                .runtime
                .as_ref()
                .is_some_and(|runtime| runtime.state.is_stopped())
    }

    /// 状态标签：没有运行态时不能说是「已停止」，那是把「不知道」说成了结论。
    pub fn state_label(&self) -> &'static str {
        match &self.runtime {
            Some(runtime) => runtime.state.label(),
            None => "无运行态",
        }
    }
}

/// 铲子运行态快照。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShovelSnapshot {
    pub rows: Vec<ShovelRow>,
    /// 读运行态失败的原因（插件未启用 / 权限不足）。非空时页面要明说
    /// 「看不到运行态」，而不是把每条铲子都显示成「无运行态」。
    pub runtime_error: Option<String>,
}

impl ShovelSnapshot {
    /// 需要关注的行数。页面顶部用来决定要不要报警。
    pub fn attention_count(&self) -> usize {
        self.rows.iter().filter(|row| row.needs_attention()).count()
    }
}

/// 把参数页拉到的铲子配置与运行态配成一张表。
///
/// 配对键是 `(vhost, name)`：同一个 vhost 下铲子名唯一，跨 vhost 可以重名。
/// 只按名字配对会在多 vhost 环境下把两件不同的事合成一行。
pub fn assemble(
    configs: &[ParameterInfo],
    runtimes: &[ShovelRuntime],
    current_vhost: &str,
    runtime_error: Option<String>,
) -> ShovelSnapshot {
    let mut rows: Vec<ShovelRow> = Vec::new();

    for config in configs
        .iter()
        .filter(|config| config.component == ParameterComponent::Shovel.component())
    {
        let runtime = runtimes
            .iter()
            .find(|runtime| {
                runtime.name == config.name && same_vhost(&runtime.vhost, &config.vhost)
            })
            .cloned();
        rows.push(build_row(
            config.name.clone(),
            config.vhost.clone(),
            Some(config.clone()),
            runtime,
            false,
        ));
    }

    // 运行态里没能配上配置的：要么是别的 vhost 的（`foreign`），要么是这个 vhost 的
    // 「孤儿」——配置被删了但进程还在，或者名字只差一个前缀。
    for runtime in runtimes {
        let paired = rows
            .iter()
            .any(|row| row.name == runtime.name && same_vhost(&row.vhost, &runtime.vhost));
        if paired {
            continue;
        }
        let foreign = !same_vhost(&runtime.vhost, current_vhost);
        rows.push(build_row(
            runtime.name.clone(),
            runtime.vhost.clone(),
            None,
            Some(runtime.clone()),
            foreign,
        ));
    }

    // 有问题的排前面：这张表的意义就是「哪条不动了」。
    rows.sort_by(|left, right| {
        right
            .needs_attention()
            .cmp(&left.needs_attention())
            .then_with(|| left.name.cmp(&right.name))
    });

    ShovelSnapshot {
        rows,
        runtime_error,
    }
}

fn build_row(
    name: String,
    vhost: String,
    config: Option<ParameterInfo>,
    runtime: Option<ShovelRuntime>,
    foreign: bool,
) -> ShovelRow {
    let problem = problem_of(config.as_ref(), runtime.as_ref(), foreign);
    ShovelRow {
        name,
        vhost,
        config,
        runtime,
        problem,
        foreign,
    }
}

/// 一条铲子的诊断。顺序按「先排除更外层的失败」：
/// 插件没启用 → 配置没跑起来 → 跑了但停了。
fn problem_of(
    config: Option<&ParameterInfo>,
    runtime: Option<&ShovelRuntime>,
    foreign: bool,
) -> String {
    if foreign {
        return "这条铲子的配置不在当前连接的 vhost 里；要改它得连到它所在的 vhost".to_owned();
    }

    match (config, runtime) {
        // 配置在、运行态没有：插件没启用 / 进程没起来 / 名字不匹配。
        (Some(_), None) => {
            "配置已保存，但没有对应的运行态：shovel 插件可能未启用，或这条配置还没被加载".to_owned()
        }
        (None, Some(runtime)) => {
            if runtime.state.is_stopped() {
                // 配置没了、进程还停在那儿：删除只删了配置，进程要等重启或手动清。
                "配置已不存在，但运行态还在（已停止）；清理需要重启节点或删除动态铲子".to_owned()
            } else {
                "没有对应配置却在运行：可能是通过管理 API 动态创建的铲子，重启节点后会消失"
                    .to_owned()
            }
        }
        (None, None) => String::new(),
        (Some(_), Some(runtime)) => {
            if runtime.state.is_stopped() {
                return if runtime.reason.trim().is_empty() {
                    "铲子已停止，且没有给出原因；它不会自动重启，消息会停在源端".to_owned()
                } else {
                    String::new()
                };
            }
            String::new()
        }
    }
}

/// vhost 归一：管理 API 对默认 vhost 有时回 `/`，有时回空串。
fn same_vhost(left: &str, right: &str) -> bool {
    normalize_vhost(left) == normalize_vhost(right)
}

fn normalize_vhost(vhost: &str) -> &str {
    if vhost.trim().is_empty() { "/" } else { vhost }
}

/// 「停一条铲子」到底会做什么。
///
/// 管理 API 没有 `POST /api/shovels/{name}/stop` 这类端点：铲子的生命周期由参数
/// 配置与 shovel 插件决定，唯一的写操作是 `DELETE /api/shovels/{vhost}/{name}`，
/// 而它对动态 / 静态两种铲子的后果完全不同 —— 一句话说清，交给界面显示。
pub fn stop_hint(runtime: &ShovelRuntime) -> &'static str {
    if runtime.kind == "dynamic" {
        "动态铲子（运行中创建的）：删掉后立刻停止，配置本来就不存在，不会自己回来"
    } else {
        "静态铲子（参数里声明的）：停止要删配置或停用 shovel 插件；单独删运行态，节点重启后它会照着配置再起来"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(vhost: &str, name: &str) -> ParameterInfo {
        ParameterInfo {
            component: "shovel".to_owned(),
            vhost: vhost.to_owned(),
            name: name.to_owned(),
            value: json!({ "src-uri": "amqp://u:p@a:5672", "dest-uri": "amqp://u:p@b:5672" }),
        }
    }

    fn runtime(vhost: &str, name: &str, state: ShovelState, reason: &str) -> ShovelRuntime {
        ShovelRuntime {
            name: name.to_owned(),
            vhost: vhost.to_owned(),
            state,
            kind: "static".to_owned(),
            reason: reason.to_owned(),
            src_uri: "amqp://u:p@a:5672".to_owned(),
            dest_uri: "amqp://u:p@b:5672".to_owned(),
            messages_transferred: 42,
        }
    }

    #[test]
    fn config_without_runtime_is_a_problem() {
        let snapshot = assemble(&[config("/", "sh1")], &[], "/", None);
        assert_eq!(snapshot.rows.len(), 1);
        assert!(snapshot.rows[0].needs_attention());
        assert!(snapshot.rows[0].problem.contains("插件"));
        // 没有运行态时不能报「已停止」——那是把「不知道」说成结论。
        assert_eq!(snapshot.rows[0].state_label(), "无运行态");
    }

    #[test]
    fn running_shovel_with_config_is_quiet() {
        let snapshot = assemble(
            &[config("/", "sh1")],
            &[runtime("/", "sh1", ShovelState::Running, "")],
            "/",
            None,
        );
        assert!(!snapshot.rows[0].needs_attention());
        assert_eq!(snapshot.rows[0].problem, "");
        assert_eq!(snapshot.rows[0].state_label(), "运行中");
    }

    #[test]
    fn terminated_with_reason_is_reported_but_terminated_without_reason_is_flagged() {
        let explained = assemble(
            &[config("/", "sh1")],
            &[runtime(
                "/",
                "sh1",
                ShovelState::Terminated,
                "failed to connect to amqp://a",
            )],
            "/",
            None,
        );
        // 有原因就交给界面显示原因本身，不再重复一句空话。
        assert_eq!(explained.rows[0].problem, "");
        assert!(explained.rows[0].needs_attention());

        let silent = assemble(
            &[config("/", "sh1")],
            &[runtime("/", "sh1", ShovelState::Terminated, "  ")],
            "/",
            None,
        );
        assert!(silent.rows[0].problem.contains("不会自动重启"));
    }

    #[test]
    fn starting_is_not_treated_as_stopped() {
        let snapshot = assemble(
            &[config("/", "sh1")],
            &[runtime("/", "sh1", ShovelState::Starting, "")],
            "/",
            None,
        );
        assert!(!snapshot.rows[0].needs_attention());
    }

    #[test]
    fn other_vhosts_are_marked_foreign_not_orphaned() {
        let snapshot = assemble(
            &[config("/", "sh1")],
            &[
                runtime("/", "sh1", ShovelState::Running, ""),
                runtime("orders", "sh9", ShovelState::Running, ""),
            ],
            "/",
            None,
        );
        let foreign = snapshot
            .rows
            .iter()
            .find(|row| row.name == "sh9")
            .expect("别的 vhost 的铲子也要出现在结果里");
        assert!(foreign.foreign);
        assert!(foreign.problem.contains("vhost"));
        // 这条不是「坏了」，是「不归这条连接管」；但界面上仍然要标出来，
        // 否则用户会以为「没配置却在跑」。
        assert!(foreign.needs_attention());
    }

    #[test]
    fn same_name_across_vhosts_pairs_by_vhost() {
        let snapshot = assemble(
            &[config("/", "sh1")],
            &[
                runtime("/", "sh1", ShovelState::Running, ""),
                runtime("orders", "sh1", ShovelState::Terminated, "boom"),
            ],
            "/",
            None,
        );
        assert_eq!(snapshot.rows.len(), 2);
        let local = snapshot
            .rows
            .iter()
            .find(|row| !row.foreign)
            .expect("本 vhost 的一行");
        assert!(local.config.is_some());
        assert_eq!(local.state_label(), "运行中");
    }

    #[test]
    fn orphan_runtime_is_explained_by_kind() {
        let dynamic = runtime("/", "sh2", ShovelState::Running, "");
        let snapshot = assemble(&[], std::slice::from_ref(&dynamic), "/", None);
        assert!(snapshot.rows[0].problem.contains("动态"));

        let stopped = runtime("/", "sh3", ShovelState::Terminated, "x");
        let snapshot = assemble(&[], &[stopped], "/", None);
        assert!(snapshot.rows[0].problem.contains("重启"));
    }

    #[test]
    fn empty_vhost_is_the_default_vhost() {
        let snapshot = assemble(
            &[config("", "sh1")],
            &[runtime("/", "sh1", ShovelState::Running, "")],
            "/",
            None,
        );
        assert_eq!(snapshot.rows.len(), 1);
        assert!(!snapshot.rows[0].needs_attention());
    }

    #[test]
    fn summary_redacts_credentials() {
        let runtime = runtime("/", "sh1", ShovelState::Running, "");
        let summary = runtime.summary();
        assert!(!summary.contains("p@a"), "口令不能出现在摘要里：{summary}");
        assert!(summary.contains("42"));
    }

    #[test]
    fn attention_sorts_first() {
        let snapshot = assemble(
            &[config("/", "aaa-ok"), config("/", "zzz-broken")],
            &[runtime("/", "aaa-ok", ShovelState::Running, "")],
            "/",
            None,
        );
        assert_eq!(snapshot.rows[0].name, "zzz-broken");
        assert_eq!(snapshot.attention_count(), 1);
    }

    #[test]
    fn runtime_error_keeps_rows() {
        let snapshot = assemble(&[config("/", "sh1")], &[], "/", Some("403".to_owned()));
        assert!(snapshot.runtime_error.is_some());
        assert_eq!(snapshot.rows.len(), 1);
    }
}
