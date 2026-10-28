//! Kafka 消息定位：按 key 或时间区间在日志里找消息。
//!
//! Kafka 没有内容索引，「查找」的唯一办法是从已知位置往后顺序读、逐条比对。
//! 因此这里的三件事必须分开看：
//!
//! 1. **起点**：时间区间给了就按时间反查 offset（Kafka 支持按时间戳定位），
//!    没给就从最早期位置开始。起点决定了这次扫描的真实代价。
//! 2. **终点**：`before` 作为停止边界，读到更晚的时间就收工；没给 `before`
//!    则只能一条条读到底。
//! 3. **上限**：扫描条数有硬上限，超了就报告 `truncated`，
//!    绝不能让人以为「只有这几条」。
//!
//! 4. **续扫**：一次扫不完是常态。结果里带回游标（见 `locate_cursor`），
//!    下次从「每个分区上次停下的位置」接着读，而不是重扫已读过的部分。
//!
//! 规则全部抽成纯函数（`matches` / `split_quota` / `needs_bidirectional` / `merge`，
//! 以及 `locate_cursor` 里的编解码与推进），网络部分只负责读取，这样可以脱离 broker 单测。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;
use rdkafka::{Message, Offset, TopicPartitionList};

use crate::broker::kafka::KafkaClient;
use crate::domain::{MessageLocate, MessageSearch, MessageSummary};
use crate::error::{AppError, AppResult};

use super::dto::summary_from_message;
use super::locate_cursor::{self, CursorStatus, LocateCursor, PartitionCursor};

/// 单次定位允许解码的最大消息条数。
///
/// 这个数字不是性能指标，而是「失控保护」：一次扫描几百万条会把界面和连接
/// 一起拖死，宁可明确告诉用户「只扫了这么多」，让他缩小时间区间再来。
pub const MAX_SCAN: u64 = 50_000;

/// 扫描的时间预算。分区多、消息稀时，条数上限很久都撞不到，得靠墙钟兜底。
const SCAN_BUDGET: Duration = Duration::from_secs(15);

/// 按内容定位时单次允许解码的最大条数。
///
/// key 定位只需要比对几十字节的 key，5 万条可以接受；内容定位要把每条
/// payload 完整解成字符串再逐字比对，代价高一个量级。所以单独设一个更紧的上限，
/// 并且**不允许**在没有时间区间的情况下发起——那等于把整段日志读一遍，
/// 这正是一路以来我反复守住的那条线。
pub const MAX_CONTENT_SCAN: u64 = 5_000;

/// 内容匹配的空内容视为「没填」。整段空白不该被当成「找内容为空的消息」。
pub fn compile_content(content: Option<&str>) -> Option<String> {
    content
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
}

/// 单条消息的内容是否命中。
///
/// 包含匹配 + 不区分大小写：用户手里通常只有一个片段（订单号、错误码），
/// 要求他记住大小写没有意义。payload 不是合法 UTF-8 时按有损转换处理，
/// 二进制消息的内容搜索本来就没有意义，但不该因此整页报错。
pub fn content_matches(payload: Option<&[u8]>, needle: Option<&str>) -> bool {
    let Some(needle) = needle else {
        return true;
    };
    let Some(payload) = payload else {
        return false;
    };
    String::from_utf8_lossy(payload)
        .to_lowercase()
        .contains(needle)
}

/// 内容定位的准入检查。
///
/// 返回 `Err` 表示这次请求不该发出：没有时间区间的内容扫描等于全量扫日志。
/// 这是刻意的拒绝，而不是「先跑起来再说」——先跑起来的结果是界面上转几十秒，
/// 最后给一句「扫了 5000 条没找到」，用户会以为消息不存在。
pub fn content_scan_issue(
    content: Option<&str>,
    after: Option<i64>,
    before: Option<i64>,
) -> Option<String> {
    let has_content = content.is_some_and(|value| !value.trim().is_empty());
    if !has_content {
        return None;
    }
    if after.is_none() && before.is_none() {
        return Some(format!(
            "按内容定位必须同时给出时间区间：内容匹配需要逐条解码消息体，没有区间就变成全量扫描日志（单次上限 {MAX_CONTENT_SCAN} 条）"
        ));
    }
    None
}

/// 单次拉取的等待时长。
const POLL_TIMEOUT: Duration = Duration::from_millis(1500);

/// consumer 每次拉取的预取条数。定位是逐条比对，预取太多只是白占内存。
const FETCH_QUEUE_SIZE: &str = "1000";

/// 扫描方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// 从区间起点往后读：各个分区都从 `after` 处开始，读到 `before` 为止。
    Forward,
    /// 从区间终点往前读：**只看每个分区的末尾**。
    ///
    /// 之所以不逐个分区反查 `before`：Kafka 的消息在分区之间不是按时间分层的，
    /// 「区间内最新的 N 条」本来就零散分布在各个分区的末尾。
    /// 逐个分区反查反而会漏掉那些「反查点之后还有一堆更新消息」的分区，
    /// 那样这份倒序结果就名不副实了。代价是可能提前读空，换来的是语义可解释。
    Backward,
}

/// 把 key 编译成可比较的字节序列。
///
/// 空 key 视为「没填」：表单里清空输入不该变成「查找 key 为空的消息」，
/// 那是另一个（很少见的）需求，不该被一个空字符串意外触发。
pub fn compile_key(key: Option<&str>) -> Option<Vec<u8>> {
    key.map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| key.as_bytes().to_vec())
}

/// 一条消息没能命中的原因。
///
/// key 对不上是「这不是你要的那条」，没什么可说；而时间维度上有一个
/// **必须说出来**的分支：消息根本没有时间戳。Kafka 0.10 之前不写时间戳，
/// 有些客户端也仍会发 `CreateTime = -1`。把它和「时间戳落在区间外」混成同一个
/// 「没找到」，用户会去怀疑自己填的区间、怀疑消息已经过期 —— 而真正的原因是
/// 这些消息压根不参与时间比较。最坏的情况是：某个 key 唯一的两条消息都没有
/// 时间戳，按 key + 区间的搜索一条都搜不出来，界面上却只说「没找到」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Miss {
    /// key 或时间戳对不上条件：这一条确实不在区间里。
    NotThisOne,
    /// 消息没有时间戳，时间区间对它不成立 —— 不是「不在区间内」，是「没法判断」。
    NoTimestamp,
}

/// 单条消息是否命中定位条件。
///
/// key 是**精确匹配**：定位的语义是「这条 key 对应的消息在哪」，
/// 模糊匹配会让 `order-1` 把 `order-10` 也捞出来，反而更难用。
pub fn matches(
    message: &MessageSummary,
    key: Option<&[u8]>,
    after: Option<i64>,
    before: Option<i64>,
) -> bool {
    matches_detail(message, key, after, before).is_none()
}

/// 与 `matches` 同一套判据，但把「为什么没命中」分出来。
///
/// 返回 `None` 表示命中；`Some(Miss)` 说明是哪种没命中。
fn matches_detail(
    message: &MessageSummary,
    key: Option<&[u8]>,
    after: Option<i64>,
    before: Option<i64>,
) -> Option<Miss> {
    if let Some(expected) = key {
        let actual = message.key.as_deref().unwrap_or_default().as_bytes();
        if actual != expected {
            return Some(Miss::NotThisOne);
        }
    }

    // 时间戳缺失（-1，broker 未设置 CreateTime）时无法判断区间：
    // 把它当作「不命中」而不是「命中」，避免区间外消息混进结果 ——
    // 但要单独记一笔，见 `Miss::NoTimestamp`。
    if after.is_some() || before.is_some() {
        let Some(timestamp) = message.timestamp else {
            return Some(Miss::NoTimestamp);
        };
        if after.is_some_and(|after| timestamp < after) {
            return Some(Miss::NotThisOne);
        }
        if before.is_some_and(|before| timestamp > before) {
            return Some(Miss::NotThisOne);
        }
    }

    None
}

/// 按两个方向拆分条数上限。奇数时多出的一条给反向（更新的消息更常被需要）。
///
/// 只给时间区间时两个方向都要用：正向那份回答「区间里最早有什么」，
/// 反向那份回答「区间里最新有什么」。各占一半，两边都不至于完全为空。
pub fn split_quota(limit: usize, bidirectional: bool) -> (usize, usize) {
    if !bidirectional {
        return (limit, 0);
    }
    let backward = limit.div_ceil(2);
    (limit - backward, backward)
}

/// 是否需要双向扫描：只有时间区间（没有 key）才值得，因为 key 命中本来就稀疏。
pub fn needs_bidirectional(key: Option<&[u8]>, after: Option<i64>, before: Option<i64>) -> bool {
    key.is_none() && after.is_some() && before.is_some()
}

/// 合并两个方向的结果：按时间倒序、去重（双向扫描可能捞到同一条）。
pub fn merge(mut items: Vec<MessageSummary>, limit: usize) -> Vec<MessageSummary> {
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| a.id.cmp(&b.id)));
    items.dedup_by(|a, b| a.id == b.id);
    items.truncate(limit);
    items
}

/// 按时间反查 offset，并说清结果是哪一种。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeAnchor {
    /// 该时间点之后的第一条消息在位点 `n`。
    At(i64),
    /// 该时间之后没有消息了：起点取分区末尾，这次扫描必然什么都不命中。
    Past(i64),
    /// 反查失败（超时、权限、leader 迁移……）。**不能**当成「没有消息」。
    Unknown,
}

/// 按时间反查 offset。
///
/// 三种结果必须分开：`Past(high)` 是一个真结论（「这个区间里没有消息」），
/// 而反查失败是「不知道」。把后者写成 `0`，一次权限不足就会把扫描起点
/// 拉回分区最早的位置 —— 于是「按 key + 时间区间找一条消息」退化成
/// 全量扫描日志，撞上 5 万条上限后只回一句「没有命中」。
fn offset_for_time(worker: &BaseConsumer, topic: &str, partition: i32, millis: i64) -> TimeAnchor {
    let mut query = TopicPartitionList::with_capacity(1);
    if let Err(_error) = query.add_partition_offset(topic, partition, Offset::Offset(millis)) {
        return TimeAnchor::Unknown;
    }

    let list = match worker.offsets_for_times(query, Timeout::After(POLL_TIMEOUT)) {
        Ok(list) => list,
        Err(_) => return TimeAnchor::Unknown,
    };

    let elements = list.elements();
    let Some(element) = elements.first() else {
        return TimeAnchor::Unknown;
    };
    if element.error().is_err() {
        return TimeAnchor::Unknown;
    }

    match element.offset() {
        // 负值（含 `Invalid`、`End`）只表示「该时间之后的第一个位点不存在」，
        // 也就是「这个时间之后没有消息了」—— 起点该是分区末尾，不是最早的位点。
        Offset::Offset(offset) if offset >= 0 => TimeAnchor::At(offset),
        _ => match worker.fetch_watermarks(topic, partition, Timeout::After(POLL_TIMEOUT)) {
            Ok((_, high)) => TimeAnchor::Past(high),
            Err(_) => TimeAnchor::Unknown,
        },
    }
}

/// 消费端进度：某个分区已经被读到哪儿。
///
/// 定位要回答的问题几乎总是「这条 key 的消息在哪」—— 而这条消息之所以被关心，
/// 通常是因为消费端刚为它报错。所以从消费端进度往后找，比从分区头开始扫
/// 少读几个数量级，也多一份「按分区的起点」说得出来的依据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommittedPoint {
    pub partition: i32,
    /// 已提交位点。-1（`__consumer_offsets` 用来表示「没有位点」）不该传进来。
    pub offset: i64,
}

/// 本次扫描的起点从哪儿来。界面要说出来，否则用户不知道自己在看哪一段日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOrigin {
    /// 时间区间：起点由 `after` 反查。
    Range,
    /// 只看消费端进度之后：用户勾了「从消费进度继续找」。
    Committed,
    /// 什么都没有：从每个分区最早的位置开始，也就是整段日志。
    FullScan,
}

impl WindowOrigin {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Range => "时间区间",
            Self::Committed => "消费端进度",
            Self::FullScan => "日志开头",
        }
    }
}

/// 起始位点的唯一来源：时间区间 > 消费端进度 > 日志开头。
///
/// 优先级是刻意的，与「谁更精确」无关：时间区间是用户明确填的条件，
/// 消费端进度是「他大概在找刚出问题的那条」，只有两者都没给才退回全量扫描。
/// 消费端进度与 `after` 同时给出时按 `after`：那是两条不同的问题，
/// 「从 A 时间到现在」和「从这个组读到的地方到现在」混在一起会得出一个
/// 两头都不成立的区间。
pub fn window_origin(after: Option<i64>, committed: Option<&[CommittedPoint]>) -> WindowOrigin {
    if after.is_some() {
        return WindowOrigin::Range;
    }
    match committed {
        Some(points) if !points.is_empty() => WindowOrigin::Committed,
        _ => WindowOrigin::FullScan,
    }
}

/// 按消费端进度把分区起点收窄到「已提交位点」。
///
/// 只对**有进度**的分区生效，其余分区保持原样（它们没有历史可跳）。
/// 位点夹进 `[low, high]`：消费端可能被重置位点、组也可能被重建，
/// 存下来的位点未必还在可读区间里。
///
/// 收窄的代价必须说出来：位点之前的消息这次不会被搜到。所以这一步只在
/// 用户明确勾了「从消费进度继续找」时做，绝不当默认行为。
pub fn narrow_to_committed(
    starts: &mut [PartitionCursor],
    committed: &[CommittedPoint],
    bounds: &HashMap<i32, (i64, i64)>,
) {
    for cursor in starts.iter_mut() {
        let Some(point) = committed
            .iter()
            .find(|item| item.partition == cursor.partition)
        else {
            continue;
        };
        let (low, high) = bounds
            .get(&cursor.partition)
            .copied()
            .unwrap_or((0, i64::MAX));
        let target = point.offset.clamp(low, high);
        // 只往前收，不往回放：`after` 反查出来的起点比消费端进度更靠后时，
        // 那个才是用户要的起点。
        if target > cursor.next {
            cursor.next = target.min(high);
        }
    }
}

/// 读一个消费组已提交的位点。
///
/// 走的是 `admin::fetch_assignment` + `admin::fetch_committed_offsets` 这一对：
/// `committed_offsets` 只查「表里列出的分区」，空表等于什么都没查（会静默返回
/// 空结果、错误码 0）。所以分区清单必须先由成员分配摊平出来。
///
/// 组里没有成员、或者成员没有分配时读不到分区 —— 此时返回空列表，让上层
/// 退回全量扫描并在结果里说明。这不是错误：一个刚停掉的组正是最常见的场景。
async fn committed_points(
    client: &KafkaClient,
    group: &str,
    topic: &str,
) -> AppResult<Vec<CommittedPoint>> {
    let worker = Arc::new(
        client
            .consumer_config(group)
            .create::<BaseConsumer>()
            .map_err(AppError::from)?,
    );
    let group = group.to_owned();
    let topic = topic.to_owned();

    tokio::task::spawn_blocking(move || -> AppResult<Vec<CommittedPoint>> {
        let assignment = match crate::broker::kafka::admin::fetch_assignment(&worker, &group) {
            Ok(assignment) => assignment,
            // 组不存在 / 权限不足：这里不阻断定位，只是没有起点可用。
            Err(_) => return Ok(Vec::new()),
        };
        let partitions: Vec<(String, i32)> = crate::domain::partition_query(&assignment)
            .into_iter()
            .filter(|(name, _)| *name == topic)
            .collect();
        if partitions.is_empty() {
            return Ok(Vec::new());
        }
        let offsets = match crate::broker::kafka::admin::fetch_committed_offsets(
            &worker,
            &group,
            &partitions,
        ) {
            Ok(offsets) => offsets,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(offsets
            .into_iter()
            .filter_map(|item| {
                item.offset.map(|offset| CommittedPoint {
                    partition: item.partition,
                    offset,
                })
            })
            .collect())
    })
    .await
    .map_err(|error| AppError::Internal(format!("消费组位点查询失败: {error}")))?
}

/// 起点说明：反查失败的分区必须点名。
///
/// 这些分区的起点退回了「最早位置」，也就是说这次扫描读得比预期多得多，
/// 而条数上限很可能在命中之前就到了 —— 只回一句「没有命中」是把
/// 「没找全」说成了「不存在」。
fn window_note(unresolved: &[i32]) -> Option<String> {
    if unresolved.is_empty() {
        return None;
    }
    Some(format!(
        "分区 {} 按时间反查起点失败（超时 / 权限 / leader 迁移），已退回各分区最早位置扫描；\
         这一部分可能没扫完，别把「没有命中」当成「不存在」",
        unresolved
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join("、")
    ))
}

/// 执行定位。
///
/// 两种入口共用一条路径：
/// - 无游标：按条件算出每个分区的起点（时间反查或分区端点），从头扫；
/// - 有游标：校验条件指纹后，从上次停下的位置接着扫。
pub async fn locate(client: &KafkaClient, request: MessageLocate) -> AppResult<MessageSearch> {
    let limit = super::super::clamp_limit(request.limit);
    let topic = request.target.trim().to_owned();
    if topic.is_empty() {
        return Err(AppError::Invalid("主题名称不能为空".to_owned()));
    }
    if matches!((request.after, request.before), (Some(after), Some(before)) if after > before) {
        return Err(AppError::Invalid("时间区间的起点晚于终点".to_owned()));
    }

    if let Some(issue) =
        content_scan_issue(request.content.as_deref(), request.after, request.before)
    {
        return Err(AppError::Invalid(issue));
    }

    let key = compile_key(request.key.as_deref());
    let content = compile_content(request.content.as_deref());
    let after = request.after;
    let before = request.before;
    // 带内容条件时不拆双向：两个方向各扫一半，等于两边都只看了区间的一头，
    // 而内容命中的位置无法预判。集中一个方向扫到底更容易解释。
    let bidir = content.is_none() && needs_bidirectional(key.as_deref(), after, before);

    // 条件指纹对不上就丢弃游标：宁可从头再扫一遍，也不要拿旧游标套新条件，
    // 那样得到的是一份「半截老查询 + 半截新查询」的结果。
    //
    // 这里要区分「没有游标」和「游标作废」，而且作废有两种理由：
    // 前端把「加载更多」当成「重新定位」时会把上一页的游标带过来，如果只说
    // 「首次扫描」，用户会以为自己看的是一份新条件的完整结果，其实只是同一批
    // 分区从头又扫了一遍；反过来，只是改了每页条数时条件确实没变，
    // 说成「条件已变化」又会让人回头去检查自己填的条件。
    let fingerprint = locate_cursor::fingerprint(&request);
    // 容量段与 `fingerprint` 里用的是同一个换算，`limit` 已经过 `clamp_limit`。
    let status = CursorStatus::of(
        request.cursor.as_deref(),
        &locate_cursor::scope_of(&request),
        locate_cursor::capacity_of(limit),
    );
    let resumed = match status {
        CursorStatus::Fresh => request.cursor.as_deref().and_then(LocateCursor::decode),
        _ => None,
    };

    // 消费端进度当起点：只在用户勾了开关、且没给时间区间时生效。
    // 组名是必需的 —— 没有组就没有「进度」这回事，静默忽略会让用户
    // 以为自己在看「从消费位点往后」的结果，其实是从日志开头扫的。
    let wants_committed = request.from_committed && after.is_none() && resumed.is_none();
    let group = request
        .group
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if request.from_committed && after.is_none() && group.is_none() {
        return Err(AppError::Invalid(
            "从消费进度找必须先选一个消费组：没有组就没有可用的位点".to_owned(),
        ));
    }

    let mut config = client.consumer_config(&format!("mqtui-locate-{}", uuid::Uuid::new_v4()));
    config.set("queued.min.messages", FETCH_QUEUE_SIZE);
    let worker: Arc<BaseConsumer> = Arc::new(config.create().map_err(AppError::from)?);

    // 位点要在搬进阻塞任务之前读：它走的是另一个 worker（group.id 必须是目标组名，
    // 而定位用的这个 consumer 用的是随机 group.id）。
    let committed = match (wants_committed, group) {
        (true, Some(group)) => Some(committed_points(client, group, &topic).await?),
        _ => None,
    };
    let origin = window_origin(after, committed.as_deref());

    let backward = resumed.as_ref().is_some_and(|cursor| cursor.backward);
    // 搬进阻塞任务：只保留分区状态，指纹在外层已经用过了。
    let resumed_partitions = resumed.map(|cursor| (cursor.backward, cursor.partitions));
    let has_resume = resumed_partitions.is_some();
    let mut window = (origin == WindowOrigin::Committed)
        .then(|| "从消费组的已提交位点往后扫描：位点之前的消息这次不会被搜到".to_owned());

    tokio::task::spawn_blocking(move || {
        let metadata = worker
            .fetch_metadata(Some(&topic), Timeout::After(POLL_TIMEOUT))
            .map_err(AppError::from)?;
        let partitions: Vec<i32> = metadata
            .topics()
            .first()
            .map(|meta| meta.partitions().iter().map(|item| item.id()).collect())
            .unwrap_or_default();
        if partitions.is_empty() {
            return Err(AppError::NotFound(format!("主题 {topic}")));
        }

        let initial = match resumed_partitions {
            // 续扫：只保留仍然存在、且还没读完的分区。
            Some((backward, partitions_state)) => locate_cursor::resume(
                &LocateCursor {
                    fingerprint: fingerprint.clone(),
                    backward,
                    partitions: partitions_state,
                },
                &partitions,
            ),
            None => {
                let layout = read_layout(&worker, &topic, &partitions)?;
                // 反查失败的分区单独记账：它们的起点只能退回分区最早位置，
                // 而这件事必须出现在结果里（见 `window`）。
                let mut unresolved: Vec<i32> = Vec::new();
                let resolved = locate_cursor::initial_starts(
                    &layout,
                    backward,
                    |partition, millis| match offset_for_time(&worker, &topic, partition, millis) {
                        TimeAnchor::At(offset) => offset,
                        TimeAnchor::Past(high) => high,
                        TimeAnchor::Unknown => {
                            unresolved.push(partition);
                            // 交出分区最早位点，让 `initial_starts` 的 clamp 给出确定结果。
                            layout
                                .iter()
                                .find(|(id, _, _)| *id == partition)
                                .map_or(0, |(_, low, _)| *low)
                        }
                    },
                    after,
                );
                unresolved.sort_unstable();
                window = window_note(&unresolved);

                let mut cursors = resolved;
                // 消费端进度只在「没有时间区间」时当起点：两者给了同一个分区时
                // 以用户明确填的时间区间为准。
                if origin == WindowOrigin::Committed
                    && let Some(points) = committed.as_deref()
                {
                    let bounds: HashMap<i32, (i64, i64)> = layout
                        .iter()
                        .map(|(partition, low, high)| (*partition, (*low, *high)))
                        .collect();
                    narrow_to_committed(&mut cursors, points, &bounds);
                }
                locate_cursor::resume(
                    &LocateCursor {
                        fingerprint: fingerprint.clone(),
                        backward,
                        partitions: cursors,
                    },
                    &partitions,
                )
            }
        };

        let (forward_quota, backward_quota) = split_quota(limit, bidir);
        let mut items = Vec::with_capacity(limit);
        let mut scanned = 0_u64;
        let mut truncated = false;
        let mut next = Vec::new();
        let mut targets = 0_usize;
        let mut undated = 0_u64;

        // 正向：从区间起点往后读，撞到 before 或时间预算就停。
        //
        // 续扫时只有与游标同向的那一份继续；跨方向续扫没有意义
        // （反向游标记录的是「从新往旧读到哪」，与正向的推进方向相反）。
        if forward_quota > 0 && (!backward || !has_resume) {
            let outcome = scan(
                &worker,
                &topic,
                Direction::Forward,
                key.as_deref(),
                content.as_deref(),
                after,
                before,
                forward_quota,
                initial.starts.clone(),
                &mut scanned,
            )?;
            items.extend(outcome.items);
            truncated |= outcome.truncated;
            targets += outcome.partitions.len();
            undated += outcome.undated;
            next.extend(outcome.partitions);
        }

        // 反向：从分区末尾往前读，目标是「区间内最新的一段」。
        // 只有带时间区间的搜索才走这条路：key 搜索不该拿最新一段冒充结果。
        //
        // 注意这里和上面是「两份各自独立的条数预算」，不是严格的时间先后关系：
        // 正向那份用来回答「区间里最早有什么」，反向那份用来回答「区间里最新有什么」。
        // 页面上的 note 会写明扫描范围，避免让两条来源混在一起时产生误解。
        if backward_quota > 0 && (backward || !has_resume) {
            let outcome = scan(
                &worker,
                &topic,
                Direction::Backward,
                key.as_deref(),
                content.as_deref(),
                after,
                before,
                backward_quota,
                initial.starts.clone(),
                &mut scanned,
            )?;
            items.extend(outcome.items);
            truncated |= outcome.truncated;
            targets += outcome.partitions.len();
            undated += outcome.undated;
            next.extend(outcome.partitions);
        }

        // 续扫游标：只要还有分区没读完就给出，让前端能继续往下翻。
        // 全部读完时不给——「翻到底了」这件事该由后端断言，前端看不到分区状态。
        let cursor = if next.iter().all(|item| item.done) {
            None
        } else {
            Some(
                LocateCursor {
                    fingerprint: fingerprint.clone(),
                    backward,
                    partitions: next,
                }
                .encode(),
            )
        };

        Ok(MessageSearch {
            items: merge(items, limit),
            scanned,
            truncated,
            note: note_of(
                &topic,
                bidir,
                after,
                before,
                key.is_some(),
                content.is_some(),
                has_resume,
            ),
            cursor,
            resumed_from: Some(resume_note(has_resume, status, targets, backward)),
            content_budget: content.map(|_| {
                format!("按内容扫描：单次最多解码 {MAX_CONTENT_SCAN} 条（已扫 {scanned} 条）")
            }),
            window,
            // 只在真的遇到时才说：这是一条「你可能白扫了」的提示，不是常驻噪音。
            undated: (undated > 0).then(|| undated_note(undated)),
        })
    })
    .await
    .map_err(|error| AppError::Internal(format!("Kafka 消息定位任务失败: {error}")))?
}

/// 读取每个分区的 `(partition, low, high)`。
fn read_layout(
    worker: &BaseConsumer,
    topic: &str,
    partitions: &[i32],
) -> AppResult<Vec<(i32, i64, i64)>> {
    partitions
        .iter()
        .map(|partition| {
            let (low, high) = worker
                .fetch_watermarks(topic, *partition, Timeout::After(POLL_TIMEOUT))
                .map_err(AppError::from)?;
            Ok((*partition, low, high))
        })
        .collect()
}

/// 本次扫描起点的说明。用户必须知道自己点的是「继续」还是「重头开始」。
///
/// `Resized` 与 `Stale` 必须分开说：条件没变却告诉用户「条件已变化」，
/// 他会回头去改条件——而真正该知道的是「每页条数变了，这一页重新分配了」。
fn resume_note(resumed: bool, status: CursorStatus, partitions: usize, backward: bool) -> String {
    match status {
        CursorStatus::Stale => return "条件已变化，上次的续扫位置作废，本次从头扫描".to_owned(),
        CursorStatus::Resized => {
            return "每页条数变了，上次的续扫位置作废，本次按新条数从头扫描".to_owned();
        }
        _ => {}
    }
    if !resumed {
        return "首次扫描".to_owned();
    }
    let direction = if backward {
        "从每页末尾往前"
    } else {
        "从上次停下处往后"
    };
    format!("续扫 {partitions} 个分区（{direction}）")
}

/// 扫描结果的中间形态。
struct Scanned {
    items: Vec<MessageSummary>,
    truncated: bool,
    /// 本次扫描后的分区状态，用于生成续扫游标。
    partitions: Vec<PartitionCursor>,
    /// 条件本来能对上、却因为没有时间戳而无法判断区间的消息条数。
    undated: u64,
}

/// 单方向扫描：从 `starts` 指定的位置起读，逐条比对，读满 `quota` 或预算耗尽就停。
///
/// `starts` 为空表示这个方向没有可读内容（例如所有分区都被上一次扫描读完了）。
#[allow(clippy::too_many_arguments)]
fn scan(
    worker: &BaseConsumer,
    topic: &str,
    direction: Direction,
    key: Option<&[u8]>,
    content: Option<&str>,
    after: Option<i64>,
    before: Option<i64>,
    quota: usize,
    starts: Vec<(i32, i64)>,
    scanned: &mut u64,
) -> AppResult<Scanned> {
    let mut cursors: Vec<PartitionCursor> = starts
        .iter()
        .map(|(partition, next)| PartitionCursor {
            partition: *partition,
            next: *next,
            done: false,
        })
        .collect();

    if cursors.is_empty() || quota == 0 {
        return Ok(Scanned {
            items: Vec::new(),
            truncated: false,
            partitions: cursors,
            undated: 0,
        });
    }

    // 边界（low / high）与读取起点一起取：推进游标时必须知道分区尽头在哪。
    let mut bounds: HashMap<i32, (i64, i64)> = HashMap::new();
    let mut assignments = TopicPartitionList::with_capacity(cursors.len());
    for cursor in &cursors {
        let (low, high) = worker
            .fetch_watermarks(topic, cursor.partition, Timeout::After(POLL_TIMEOUT))
            .map_err(AppError::from)?;
        bounds.insert(cursor.partition, (low, high));
        // 起点被 clamp 到分区范围内：游标可能来自上一次扫描，期间日志被 retention 清过。
        let start = cursor.next.clamp(low, high.saturating_sub(1).max(low));
        assignments
            .add_partition_offset(topic, cursor.partition, Offset::Offset(start))
            .map_err(AppError::from)?;
    }

    worker.assign(&assignments).map_err(AppError::from)?;

    let deadline = Instant::now() + SCAN_BUDGET;
    let mut items = Vec::new();
    let mut truncated = false;
    let mut undated = 0_u64;
    // 每个分区本次读到的最远位置。反向取最小值，正向取最大值。
    let mut reached: HashMap<i32, i64> = HashMap::new();
    let backward = direction == Direction::Backward;

    // 正向读到区间终点之后就没必要继续了：多分区下无法「提前停止分配」，
    // 但可以在这里收手，少解一批消息。
    let mut past_range = false;

    // 内容定位的条数上限单独收窄：每条都要解 payload 再逐字比对，代价比 key 比对高一个量级。
    let max_scan = if content.is_some() {
        MAX_CONTENT_SCAN
    } else {
        MAX_SCAN
    };

    while items.len() < quota && !past_range {
        if *scanned >= max_scan || Instant::now() >= deadline {
            truncated = true;
            break;
        }

        match worker.poll(POLL_TIMEOUT) {
            Some(Ok(message)) => {
                *scanned += 1;
                let summary = summary_from_message(&message);
                if let (Some(partition), Some(offset)) = (summary.partition, summary.offset) {
                    reached
                        .entry(partition)
                        .and_modify(|current| {
                            *current = if backward {
                                (*current).min(offset)
                            } else {
                                (*current).max(offset)
                            };
                        })
                        .or_insert(offset);
                }
                // 读到区间终点之后就没必要继续了：正向读到的是「更晚」，反向读到的是
                // 「更早」，两个方向在这一条上是对称的。
                //
                // 反向缺了这一条时，它会把**区间之后**的消息也收进来：命中判据 `matches`
                // 里的 `before` 只在双向扫描（两个时间端都给）时才被用上，而只给
                // `before` 的 key / 内容定位恰好走的就是反向。那一刻「区间里最新的一条」
                // 其实是区间外的消息，用户按它去核算完全对不上。
                //
                // 多分区交错投递下，一条越界消息不代表别的分区也越界：循环里每条命中
                // 仍要过 `matches`，越界的那条自己进不来。
                if before.is_some_and(|before| summary.timestamp.is_some_and(|ts| ts > before)) {
                    past_range = true;
                }
                match matches_detail(&summary, key, after, before) {
                    None => {
                        if content_matches(message.payload(), content) {
                            items.push(summary);
                        }
                    }
                    // 「这条不在你要的区间里」和「这条没有时间信息、判不了区间」
                    // 是两件事。前者没什么可说，后者必须回到界面上 ——
                    // 否则一轮扫完只说「没找到」，而真相是这些消息永远不参与时间比较。
                    Some(Miss::NoTimestamp) => {
                        if content_matches(message.payload(), content) {
                            undated += 1;
                        }
                    }
                    Some(Miss::NotThisOne) => {}
                }
            }
            // 分区读完是正常终止条件。
            Some(Err(rdkafka::error::KafkaError::PartitionEOF(_))) => break,
            Some(Err(error)) => return Err(AppError::from(error)),
            None => break,
        }
    }

    // 推进每个分区的状态：读到的位置往前走，没读到的保持不动。
    for cursor in &mut cursors {
        let (low, high) = bounds
            .get(&cursor.partition)
            .copied()
            .unwrap_or((0, i64::MAX));
        let read = reached.get(&cursor.partition).copied();
        locate_cursor::advance(cursor, read, low, high, backward);
    }

    // 反向读取拿到的是「从新到旧」，统一成时间倒序输出。
    items.sort_by_key(|item| std::cmp::Reverse(item.timestamp));
    Ok(Scanned {
        items,
        truncated,
        partitions: cursors,
        undated,
    })
}

/// 「有时间条件，但有些消息没有时间戳」时的说明。
///
/// 这句话存在的理由：这些消息**条件本来对得上**（key 匹配、内容也命中），
/// 只是没有 `CreateTime`，所以永远进不了时间区间。不说，用户就会把
/// 「没找到」当成「不存在」—— 而它们明明在那里。
fn undated_note(count: u64) -> String {
    format!(
        "另有 {count} 条消息满足 key / 内容条件但没有时间戳（Kafka 0.10 之前或客户端未设置 CreateTime），         无法判断是否落在这次的时间区间里，因此没有计入结果；去掉时间区间再搜一次能把它们找出来"
    )
}

/// 给用户一句人话，说明这次扫描的范围和代价。
fn note_of(
    topic: &str,
    bidir: bool,
    after: Option<i64>,
    before: Option<i64>,
    has_key: bool,
    has_content: bool,
    resumed: bool,
) -> String {
    let scope = match (after, before) {
        (Some(_), Some(_)) => "一份从区间起点往后扫、一份从分区末尾往前扫",
        (Some(_), None) => "从区间起点往后扫描",
        (None, Some(_)) => "从分区末尾往前扫描",
        (None, None) => "从最早位置开始扫描",
    };
    let quota = if bidir {
        "（两份各占一半条数）"
    } else {
        ""
    };
    let condition = match (has_key, has_content) {
        (true, true) => "按 key 精确匹配 + 内容包含匹配（两个条件都要满足）",
        (true, false) => "按 key 精确匹配",
        (false, true) => "按内容包含匹配（不区分大小写）",
        (false, false) => "未指定 key",
    };
    let stage = if resumed { "（续扫）" } else { "" };
    format!("{topic}：{scope}{quota}，{condition}{stage}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, key: Option<&str>, timestamp: Option<i64>) -> MessageSummary {
        MessageSummary {
            id: id.to_owned(),
            key: key.map(str::to_owned),
            topic: Some("orders".to_owned()),
            partition: Some(0),
            offset: Some(1),
            timestamp,
            preview: "hi".to_owned(),
            size: Some(2),
            payload: None,
        }
    }

    #[test]
    fn empty_key_means_no_key_filter() {
        assert!(compile_key(Some("  ")).is_none());
        assert!(compile_key(None).is_none());
        assert_eq!(compile_key(Some(" v1 ")), Some(b"v1".to_vec()));
    }

    #[test]
    fn key_match_is_exact() {
        let message = summary("m", Some("order-1"), Some(100));
        assert!(matches(&message, Some(b"order-1"), None, None));
        // 前缀不算命中：order-1 不该把 order-10 捞出来。
        assert!(!matches(&message, Some(b"order"), None, None));
        assert!(!matches(&message, Some(b"order-10"), None, None));
    }

    #[test]
    fn missing_key_never_matches_key_filter() {
        let message = summary("m", None, Some(100));
        assert!(!matches(&message, Some(b"order-1"), None, None));
    }

    #[test]
    fn time_range_is_inclusive() {
        let message = summary("m", None, Some(100));
        assert!(matches(&message, None, Some(100), Some(100)));
        assert!(!matches(&message, None, Some(101), None));
        assert!(!matches(&message, None, None, Some(99)));
    }

    #[test]
    fn messages_without_timestamp_are_excluded_by_time_range() {
        let message = summary("m", None, None);
        assert!(!matches(&message, None, Some(0), None));
        // 不给时间区间时不该因为缺时间戳被排除。
        assert!(matches(&message, None, None, None));
    }

    #[test]
    fn missing_timestamp_is_not_the_same_as_out_of_range() {
        // 回归：这两件事以前在界面上都表现为「没找到」。前者是「确实不在区间里」，
        // 后者是「这条消息压根没有时间信息，判不了」—— 后者必须能说出来，
        // 否则一个 key 唯一的两条消息都没有时间戳时，搜索结果是空的而理由说不清。
        let undated = summary("m", Some("order-1"), None);
        assert_eq!(
            matches_detail(&undated, Some(b"order-1"), Some(1), Some(9)),
            Some(Miss::NoTimestamp)
        );

        let out_of_range = summary("m2", Some("order-1"), Some(100));
        assert_eq!(
            matches_detail(&out_of_range, Some(b"order-1"), Some(1), Some(9)),
            Some(Miss::NotThisOne)
        );

        // key 对不上时仍然是「不是这条」，不该被算成「没有时间戳」。
        assert_eq!(
            matches_detail(&undated, Some(b"order-2"), Some(1), Some(9)),
            Some(Miss::NotThisOne)
        );
        // 没有时间区间时，缺时间戳不影响命中。
        assert_eq!(matches_detail(&undated, Some(b"order-1"), None, None), None);
    }

    #[test]
    fn undated_note_says_they_are_not_missing() {
        let note = undated_note(3);
        assert!(note.contains('3'));
        // 必须给出下一步怎么做，否则用户只会去改时间区间。
        assert!(note.contains("去掉时间区间"));
    }

    #[test]
    fn key_and_time_range_intersect() {
        let message = summary("m", Some("v1"), Some(100));
        assert!(matches(&message, Some(b"v1"), Some(0), Some(200)));
        assert!(!matches(&message, Some(b"v1"), Some(200), None));
    }

    #[test]
    fn blank_content_means_no_content_filter() {
        assert!(compile_content(Some("   ")).is_none());
        assert!(compile_content(None).is_none());
        assert_eq!(
            compile_content(Some(" Order-1 ")),
            Some("order-1".to_owned())
        );
    }

    #[test]
    fn content_match_is_case_insensitive_and_substring() {
        let payload = Some("{\"msg\":\"ORDER-1001 created\"}".as_bytes());
        let needle = compile_content(Some("order-1001"));
        assert!(content_matches(payload, needle.as_deref()));
        let needle = compile_content(Some("100"));
        assert!(content_matches(payload, needle.as_deref()));
        let needle = compile_content(Some("1002"));
        assert!(!content_matches(payload, needle.as_deref()));
    }

    #[test]
    fn no_content_condition_matches_everything() {
        assert!(content_matches(None, None));
        assert!(content_matches(Some(b"x"), None));
    }

    #[test]
    fn invalid_utf8_payload_does_not_panic() {
        // 二进制消息的内容搜索没有意义，但不能因此整页报错。
        let payload = [0xff, 0xfe, b'a', b'b'];
        let needle = compile_content(Some("ab"));
        assert!(content_matches(Some(&payload), needle.as_deref()));
    }

    #[test]
    fn content_scan_requires_a_time_range() {
        // 没有时间区间的内容扫描等于全量扫日志，必须拒绝。
        assert!(content_scan_issue(Some("order"), None, None).is_some());
        assert!(content_scan_issue(Some("order"), Some(1), None).is_none());
        assert!(content_scan_issue(Some("order"), None, Some(2)).is_none());
        // 不填内容时与时间区间无关。
        assert!(content_scan_issue(None, None, None).is_none());
        assert!(content_scan_issue(Some("  "), None, None).is_none());
    }

    #[test]
    fn bidirectional_only_for_time_range_without_key() {
        assert!(needs_bidirectional(None, Some(1), Some(2)));
        assert!(!needs_bidirectional(Some(b"k"), Some(1), Some(2)));
        assert!(!needs_bidirectional(None, Some(1), None));
        assert!(!needs_bidirectional(None, None, Some(2)));
    }

    #[test]
    fn quota_splits_with_extra_to_backward() {
        assert_eq!(split_quota(10, false), (10, 0));
        assert_eq!(split_quota(10, true), (5, 5));
        // 奇数时反向多拿一条：更新的消息更常被需要。
        assert_eq!(split_quota(5, true), (2, 3));
        assert_eq!(split_quota(1, true), (0, 1));
    }

    #[test]
    fn merge_sorts_desc_and_dedups() {
        let items = vec![
            summary("a", None, Some(100)),
            summary("b", None, Some(300)),
            summary("a", None, Some(100)),
            summary("c", None, Some(200)),
        ];
        let merged = merge(items, 10);
        assert_eq!(
            merged
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "c", "a"]
        );
    }

    /// 反向扫描遇到第一条晚于 `before` 的消息就必须收手。
    ///
    /// 这是一个只做「读顺序」的判定，无法脱离 broker 跑完整 `scan`，
    /// 所以这里把循环里那条判断单独固化：晚于 `before` → 收手；早于或等于 → 继续。
    #[test]
    fn backward_scan_stops_once_past_before() {
        let before = Some(1_000);
        let stop = |timestamp: Option<i64>| {
            before.is_some_and(|before| timestamp.is_some_and(|ts| ts > before))
        };

        // 区间内的消息不该让扫描停下。
        assert!(!stop(Some(900)));
        assert!(!stop(Some(1_000)));
        // 晚于 `before` 的消息：反向从这里开始已经出了区间，继续读只会读到更早的
        // （同样在区间外或有更近区间边界的问题），所以必须收手。
        assert!(stop(Some(1_001)));
        // 没有时间戳时不做判断：宁可多读几条，也不要凭空断言「区间读完了」。
        assert!(!stop(None));
    }

    #[test]
    fn merge_respects_limit() {
        let items = (0..5)
            .map(|index| summary(&format!("m{index}"), None, Some(index)))
            .collect();
        assert_eq!(merge(items, 2).len(), 2);
    }

    #[test]
    fn resume_note_distinguishes_stale_condition_from_resized_page() {
        // 两种作废理由说的不是一回事：条件变了让人去改条件；
        // 条数变了只是这一页重新分配，说成「条件已变化」会把人带偏。
        let stale = resume_note(false, CursorStatus::Stale, 0, false);
        assert!(stale.contains("条件已变化"));

        let resized = resume_note(false, CursorStatus::Resized, 0, false);
        assert!(resized.contains("每页条数"));
        assert!(!resized.contains("条件已变化"));

        // 正常续扫与首次扫描不受影响。
        assert!(resume_note(false, CursorStatus::Absent, 0, false).contains("首次扫描"));
        let resumed = resume_note(true, CursorStatus::Fresh, 3, false);
        assert!(resumed.contains("续扫 3 个分区"));
        assert!(resumed.contains("往后"));
        assert!(resume_note(true, CursorStatus::Fresh, 2, true).contains("往前"));
    }

    #[test]
    fn note_mentions_scan_scope() {
        let note = note_of("orders", true, Some(1), Some(2), false, false, false);
        assert!(note.contains("orders"));
        assert!(note.contains("两份"));
        assert!(note.contains("未指定 key"));

        let keyed = note_of("orders", false, None, None, true, false, false);
        assert!(keyed.contains("最早位置"));
        assert!(keyed.contains("按 key 精确匹配"));
    }

    // ---- 扫描起点 -------------------------------------------------------

    #[test]
    fn window_origin_prefers_the_range_the_user_typed() {
        let points = [CommittedPoint {
            partition: 0,
            offset: 100,
        }];
        // 时间区间是用户明确填的条件，消费端进度只是「大概从哪开始」。
        assert_eq!(
            window_origin(Some(1_000), Some(&points)),
            WindowOrigin::Range
        );
        assert_eq!(window_origin(None, Some(&points)), WindowOrigin::Committed);
        // 组里没有可用进度时退回全量扫描，而不是「从 0 开始」这种假起点。
        assert_eq!(window_origin(None, Some(&[])), WindowOrigin::FullScan);
        assert_eq!(window_origin(None, None), WindowOrigin::FullScan);
    }

    fn cursor(partition: i32, next: i64) -> PartitionCursor {
        PartitionCursor {
            partition,
            next,
            done: false,
        }
    }

    #[test]
    fn committed_progress_only_moves_starts_forward() {
        let mut starts = vec![cursor(0, 10), cursor(1, 10), cursor(2, 500)];
        let points = [
            CommittedPoint {
                partition: 0,
                offset: 400,
            },
            // 消费端位点不在可读区间里（组被重置过、位点被清理过）。
            CommittedPoint {
                partition: 1,
                offset: -1,
            },
        ];
        let bounds = HashMap::from([(0, (0, 1_000)), (1, (0, 1_000)), (2, (0, 1_000))]);
        narrow_to_committed(&mut starts, &points, &bounds);

        assert_eq!(
            starts[0].next, 400,
            "有进度的分区从位点开始：这才叫「往后找」"
        );
        assert_eq!(
            starts[1].next, 10,
            "负位点夹到区间下界后落在原地：既不推成负数，也不会把起点往回拉"
        );
        assert_eq!(starts[2].next, 500, "没有进度的分区保持原样");

        // 位点比现有起点更靠前时不往回放：`after` 反查出来的起点更精确。
        let mut behind = vec![cursor(0, 900)];
        narrow_to_committed(
            &mut behind,
            &[CommittedPoint {
                partition: 0,
                offset: 100,
            }],
            &HashMap::from([(0, (0, 1_000))]),
        );
        assert_eq!(behind[0].next, 900);
    }

    #[test]
    fn unknown_time_anchor_is_not_silently_zero() {
        // 回归：反查失败以前是 `unwrap_or(0)`，于是「按 key + 时间区间」退化成
        // 从分区最早位置开始的全量扫描 —— 扫到 5 万条上限后只说一句「没有命中」。
        // 现在失败是 `Unknown`，起点退回分区最早位置，但会作为 `window` 说出来。
        let note = window_note(&[3, 7]).expect("反查失败必须留下说明");
        assert!(note.contains('3') && note.contains('7'), "{note}");
        assert!(
            note.contains("没有命中") && note.contains("不存在"),
            "{note}"
        );
        // 全部反查成功时不制造噪音。
        assert!(window_note(&[]).is_none());
    }
}
