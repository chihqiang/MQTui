//! Kafka 管理类查询：消费组列表与详情。
//!
//! 全部基于 rdkafka 的 `BaseConsumer`：`fetch_group_list` 拿组、成员与提交位点，
//! `fetch_watermarks` 拿分区末尾位点算滞后。这些调用都是阻塞的，
//! 由 `message::kafka::consumer_groups` 包进阻塞线程池执行，本模块只做数据组装。
//!
//! 文件里同时放着「分页游标」的编解码纯函数：游标是没有任何 I/O 的字符串变换，
//! 放在这里可以脱离网络和 broker 直接单测。

use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::util::Timeout;

use rdkafka::groups::{GroupInfo, GroupMemberInfo};

use crate::domain::{
    ConsumerGroupDetail, ConsumerGroupInfo, ConsumerGroupMember, ConsumerGroupOffset,
    ConsumerGroupQuery, GroupAssignment,
};
use crate::error::{AppError, AppResult};

/// 一页消费组的默认条数。
pub const DEFAULT_GROUP_LIMIT: usize = 100;
/// 单页上限，防止一次把几万个组全拉进内存。
pub const MAX_GROUP_LIMIT: usize = 500;
/// 分组元数据请求超时。
pub const GROUPS_TIMEOUT: Timeout = Timeout::After(std::time::Duration::from_secs(10));

/// 裁剪查询条数到允许范围。
pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_GROUP_LIMIT)
        .clamp(1, MAX_GROUP_LIMIT)
}

/// 按关键字过滤组名：忽略大小写的包含匹配。
///
/// 服务端的前缀匹配（`fetch_group_list(Some(prefix))`）只能替代一部分场景，
/// 用户想搜「中间那段」时只能本地再筛一遍，所以这里两个都做。
pub fn matches_keyword(name: &str, keyword: &str) -> bool {
    keyword.is_empty() || name.to_lowercase().contains(&keyword.to_lowercase())
}

/// 分页游标：记录上一页最后一个组名，下一页从它之后开始。
///
/// 消费组按名称升序排列，所以「最后一个名字」足以标识进度，
/// 不需要把已返回的组名整体塞进游标。
pub fn encode_cursor(last_name: &str) -> String {
    format!("after={last_name}")
}

/// 解析游标，返回「从哪个名字之后开始」。
///
/// 空游标视为从头开始（返回 `None`），让前端把 `undefined` 透传成空值时不会报错。
pub fn decode_cursor(cursor: Option<&str>) -> AppResult<Option<String>> {
    let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) else {
        return Ok(None);
    };
    cursor
        .strip_prefix("after=")
        .map(|name| Some(name.to_owned()))
        .ok_or_else(|| AppError::Invalid(format!("非法的消费组游标: {cursor}")))
}

/// 对按名称升序排列的组名做一页切片，返回该页在 `names` 中的下标。
///
/// 分页逻辑独立成纯函数，便于覆盖「游标指向已消失的组」这类边界：
/// 游标里的名字可能因为组被删除而不存在，此时按字典序定位插入点，
/// 而不是直接报错或从头开始。
pub fn slice_by_name(names: &[&str], after: Option<&str>, limit: usize) -> Vec<usize> {
    let start = match after {
        None => 0,
        Some(cursor) => match names.binary_search(&cursor) {
            // 游标对应的组还在：从它后面一个开始。
            Ok(index) => index + 1,
            // 组已消失：从「本该在它后面的第一个」开始。
            Err(index) => index,
        },
    };

    if start >= names.len() {
        return Vec::new();
    }

    let end = start.saturating_add(limit).min(names.len());
    (start..end).collect()
}

/// 拉取全部消费组（含成员数量），并应用关键字过滤、排序、分页。
///
/// 返回 `(本页组, 是否还有下一页, 下一页游标)`。
pub fn fetch_groups(
    worker: &BaseConsumer,
    query: &ConsumerGroupQuery,
    limit: Option<usize>,
    cursor: Option<&str>,
) -> AppResult<(Vec<ConsumerGroupInfo>, bool, Option<String>)> {
    let keyword = query.keyword.as_deref().unwrap_or("").trim();
    let after = decode_cursor(cursor)?;

    // 关键字同时作为服务端前缀，能少拉一批无关的组；服务端不支持时也无副作用。
    let prefix = (!keyword.is_empty()).then_some(keyword);
    let list = worker
        .fetch_group_list(prefix, GROUPS_TIMEOUT)
        .map_err(AppError::from)?;

    let groups = normalize_groups(list.groups(), keyword);
    Ok(page_groups(&groups, after.as_deref(), clamp_limit(limit)))
}

/// 把 rdkafka 的组列表翻译成领域模型：过滤、按名称排序。
pub fn normalize_groups(groups: &[GroupInfo], keyword: &str) -> Vec<ConsumerGroupInfo> {
    let mut items: Vec<ConsumerGroupInfo> = groups
        .iter()
        .filter(|group| matches_keyword(group.name(), keyword))
        .map(|group| ConsumerGroupInfo {
            name: group.name().to_owned(),
            state: group.state().to_owned(),
            members: group.members().len(),
            // 滞后量需要逐分区查水位，列表阶段代价太大，详情里再算。
            total_lag: None,
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items
}

/// 对已排序的组列表分页，返回 `(本页, 是否还有下一页, 下一页游标)`。
pub fn page_groups(
    groups: &[ConsumerGroupInfo],
    after: Option<&str>,
    limit: usize,
) -> (Vec<ConsumerGroupInfo>, bool, Option<String>) {
    let names: Vec<&str> = groups.iter().map(|group| group.name.as_str()).collect();
    let indices = slice_by_name(&names, after, limit);
    let page: Vec<ConsumerGroupInfo> = indices.iter().map(|index| groups[*index].clone()).collect();

    // 游标指「下一页从哪个名字之后开始」，所以只要这一页不空就得给 ——
    // 前端靠它翻页。但它不能直接当 `has_more`：`slice_by_name` 会一直切到
    // 名单末尾，最后一页照样有游标，于是「加载更多」亮着、点一下什么都没有。
    let next_cursor = page.last().map(|group| encode_cursor(&group.name));
    let has_more = indices.last().is_some_and(|last| last + 1 < names.len());
    (page, has_more, next_cursor)
}

/// 拉取单个消费组的成员与各分区进度。
///
/// 滞后量需要「末尾位点」，只能逐分区问 broker；分区数通常不大，
/// 但为避免几十个分区串行等待，这里用 `fetch_watermarks` 逐次调用并直接累加。
pub fn fetch_detail(worker: &BaseConsumer, group_name: &str) -> AppResult<ConsumerGroupDetail> {
    let list = worker
        .fetch_group_list(Some(group_name), GROUPS_TIMEOUT)
        .map_err(AppError::from)?;

    let Some(group) = list
        .groups()
        .iter()
        .find(|group| group.name() == group_name)
    else {
        return Err(AppError::NotFound(format!("消费组 {group_name}")));
    };

    let members = group
        .members()
        .iter()
        .map(|member| ConsumerGroupMember {
            member_id: non_empty(member.id()),
            client_id: non_empty(member.client_id()),
            client_host: non_empty(member.client_host()),
        })
        .collect::<Vec<_>>();

    // rdkafka 的 `GroupInfo` 只带成员，不带位点；已提交位点要另行查服务端。
    let offsets = fetch_committed_offsets(worker, group_name)?;

    Ok(assemble_detail(
        group.name(),
        group.state(),
        members,
        offsets,
    ))
}

/// 读一个消费组的成员分区归属。
///
/// 与 `fetch_detail` 分两次请求是刻意的：详情是「每个分区落后多少」，
/// 归属是「谁在读这个分区」。它们来自同一份组成员快照，但用途不同 ——
/// 合成一个返回会把详情页拖成「必须读完分配才能显示滞后」。
///
/// 组不存在时报错（不是返回空归属）：一张空的归属表和「这个组没有成员分区」
/// 长得一模一样，而前者是在说一个不存在的组很健康。
pub fn fetch_assignment(worker: &BaseConsumer, group_name: &str) -> AppResult<GroupAssignment> {
    let list = worker
        .fetch_group_list(Some(group_name), GROUPS_TIMEOUT)
        .map_err(AppError::from)?;

    let Some(group) = list
        .groups()
        .iter()
        .find(|group| group.name() == group_name)
    else {
        return Err(AppError::NotFound(format!("消费组 {group_name}")));
    };

    Ok(assemble_assignment(group))
}

/// 把组快照里的成员分配翻译成领域模型。
///
/// 分配是二进制（消费者协议的 `MemberAssignment`），要靠 `protocol_type` 判断
/// 该不该按那个格式读：Kafka Connect、事务协调器这类组的消息格式是它们自己定义的，
/// 硬解出来的分区归属会是垃圾，而垃圾报表比没有表更糟。
///
/// 抽成不碰网络的函数，是为了让「哪种协议不适用」这条判断能被单测钉住。
pub fn assemble_assignment(group: &GroupInfo) -> GroupAssignment {
    let protocol_type = group.protocol_type();
    if !protocol_type.eq_ignore_ascii_case("consumer") {
        return crate::domain::group_assignment_unavailable(protocol_type);
    }

    let members: Vec<(String, Vec<u8>)> = group
        .members()
        .iter()
        .map(|member| (member.id().to_owned(), assignment_bytes(member)))
        .collect();
    crate::domain::assemble_group_assignment(members)
}

/// 成员的分配字节。没有分配时给空切片 —— 空切片表示「没有分区」，
/// 与「读不懂」在领域层是两种结论。
fn assignment_bytes(member: &GroupMemberInfo) -> Vec<u8> {
    member.assignment().map_or_else(Vec::new, <[u8]>::to_vec)
}

/// 组装详情：滞后量由位点列表累加得出，空组给 `None` 而不是 0。
pub fn assemble_detail(
    name: &str,
    state: &str,
    members: Vec<ConsumerGroupMember>,
    offsets: Vec<ConsumerGroupOffset>,
) -> ConsumerGroupDetail {
    let total_lag = (!offsets.is_empty()).then(|| offsets.iter().map(|item| item.lag).sum());

    ConsumerGroupDetail {
        group: ConsumerGroupInfo {
            name: name.to_owned(),
            state: state.to_owned(),
            members: members.len(),
            total_lag,
        },
        members,
        offsets,
    }
}

/// 确认一个消费组存在，不存在时报错而不是返回空结果。
///
/// 拉取组列表用的是**完整组名**做前缀再精确比对：`fetch_group_list` 的前缀
/// 匹配会把 `orders` 也匹配到 `orders-v2`，直接取第一条就会读错组的位点。
pub fn probe_group(worker: &BaseConsumer, group_name: &str) -> AppResult<()> {
    let list = worker
        .fetch_group_list(Some(group_name), GROUPS_TIMEOUT)
        .map_err(AppError::from)?;
    let found = list.groups().iter().any(|group| group.name() == group_name);
    if found {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("消费组 {group_name}")))
    }
}

/// 查询消费组已提交位点并计算滞后。
///
/// rdkafka 的 `committed_offsets` 只返回「当前 consumer 的 group.id 视角」下的分区，
/// 因此调用方的 `worker` 必须是以目标组名作为 `group.id` 建出来的 consumer，
/// 见 `message::kafka::consumer_groups`。
pub fn fetch_committed_offsets(
    worker: &BaseConsumer,
    group_name: &str,
) -> AppResult<Vec<ConsumerGroupOffset>> {
    let committed = worker
        .committed_offsets(rdkafka::TopicPartitionList::new(), GROUPS_TIMEOUT)
        .map_err(|error| AppError::Broker(format!("查询消费组 {group_name} 位点失败: {error}")))?;

    let mut offsets = Vec::new();
    for element in committed.elements() {
        let Some(offset) = element.offset().to_raw() else {
            // 分区没有有效位点（`Offset::Invalid`），跳过而不是当成 0。
            continue;
        };
        let (low, high) = worker
            .fetch_watermarks(element.topic(), element.partition(), GROUPS_TIMEOUT)
            .map_err(AppError::from)?;
        offsets.push(ConsumerGroupOffset {
            topic: element.topic().to_owned(),
            partition: element.partition(),
            offset: Some(offset),
            high,
            lag: partition_lag(offset, low, high),
        });
    }
    offsets.sort_by(|a, b| a.topic.cmp(&b.topic).then(a.partition.cmp(&b.partition)));
    Ok(offsets)
}

/// 单分区滞后量。
///
/// 位点可能已被 retention 清理到 `low` 之前，也可能被写到了 `high` 之后
/// （业务方手动改位点、或者干脆写错了一个巨大值）。两种情形下「末尾 - 位点」
/// 都会算出错误的数字：
///
/// - 位点 < `low`：这些消息已经不在日志里了，正确读数是 `high - low`。
///   直接减得出来的数是**虚高**的滞后，人会去查一个并不存在的堆积。
/// - 位点 > `high`：消费者其实已经跳过了全部现存消息，滞后是 0。
///   直接减出来是负数，界面上得靠 `.max(0)` 兜住 —— 兜是对的，但要把
///   「位点越界」这件事在这里说清，否则下一个人会以为是取整问题。
///
/// 所以先把位点夹进 `[low, high]` 再减：结果永远落在真实的可能区间里。
pub fn partition_lag(offset: i64, low: i64, high: i64) -> i64 {
    let from = offset.clamp(low.min(high), high);
    (high - from).max(0)
}

/// 把空字符串当 `None`：服务端对缺失字段返回空串而不是缺省。
fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn keyword_filter_is_case_insensitive() {
        assert!(matches_keyword("Orders-Worker", "worker"));
        assert!(matches_keyword("orders-worker", "orders"));
        assert!(!matches_keyword("orders-worker", "payment"));
        assert!(matches_keyword("anything", ""));
    }

    #[test]
    fn cursor_roundtrip() {
        let cursor = encode_cursor("orders-worker");
        assert_eq!(cursor, "after=orders-worker");
        assert_eq!(
            decode_cursor(Some(&cursor)).expect("解析失败").as_deref(),
            Some("orders-worker")
        );
    }

    #[test]
    fn empty_cursor_means_start() {
        assert!(decode_cursor(None).expect("解析失败").is_none());
        assert!(decode_cursor(Some("")).expect("解析失败").is_none());
    }

    #[test]
    fn garbage_cursor_is_rejected() {
        assert!(decode_cursor(Some("orders-worker")).is_err());
        assert!(decode_cursor(Some("after")).is_err());
    }

    #[test]
    fn first_page_stops_at_limit() {
        let all = names(&["a", "b", "c"]);
        let refs: Vec<&str> = all.iter().map(String::as_str).collect();
        assert_eq!(slice_by_name(&refs, None, 2), [0, 1]);
    }

    #[test]
    fn cursor_continues_after_name() {
        let all = names(&["a", "b", "c"]);
        let refs: Vec<&str> = all.iter().map(String::as_str).collect();
        assert_eq!(slice_by_name(&refs, Some("b"), 2), [2]);
    }

    #[test]
    fn vanished_cursor_does_not_restart_from_head() {
        // 游标里的组已被删除：应从字典序位置继续，而不是回到第一页。
        let all = names(&["a", "c", "d"]);
        let refs: Vec<&str> = all.iter().map(String::as_str).collect();
        assert_eq!(slice_by_name(&refs, Some("b"), 10), [1, 2]);
    }

    #[test]
    fn cursor_past_the_end_yields_empty_page() {
        let all = names(&["a", "b"]);
        let refs: Vec<&str> = all.iter().map(String::as_str).collect();
        assert!(slice_by_name(&refs, Some("z"), 10).is_empty());
    }

    fn group(name: &str) -> ConsumerGroupInfo {
        ConsumerGroupInfo {
            name: name.to_owned(),
            state: "Empty".to_owned(),
            members: 0,
            total_lag: None,
        }
    }

    #[test]
    fn last_page_does_not_pretend_there_is_more() {
        // 回归：游标只要这一页不空就会给，而 `has_more` 以前直接抄了
        // 「游标存不存在」。于是最后一页也带着游标、`has_more` 为真，
        // 界面上「加载更多」亮着，点一下换回一个空页 —— 按钮永远消不掉。
        let groups = vec![group("a"), group("b"), group("c")];

        let (page, has_more, cursor) = page_groups(&groups, None, 2);
        assert_eq!(page.len(), 2);
        assert!(has_more, "后面还有 c");
        assert_eq!(cursor.as_deref(), Some("after=b"));

        let (page, has_more, cursor) = page_groups(&groups, Some("b"), 2);
        assert_eq!(
            page.iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["c"]
        );
        assert!(!has_more, "已经是最后一页");
        // 游标仍要给：它标识「读到哪个名字了」，只是不再声称还有下一页。
        assert_eq!(cursor.as_deref(), Some("after=c"));
    }

    #[test]
    fn exactly_fitting_page_reports_no_more() {
        // 恰好装下：3 个组、每页 3 条。以前这里同样会多亮一次「加载更多」。
        let groups = vec![group("a"), group("b"), group("c")];
        let (page, has_more, _) = page_groups(&groups, None, 3);
        assert_eq!(page.len(), 3);
        assert!(!has_more);
    }

    #[test]
    fn lag_clamps_offset_into_retained_range() {
        // 位点被 retention 清到 low 之前：堆积是第一段现存消息，不是「末尾 - 旧位点」。
        assert_eq!(partition_lag(0, 100, 300), 200);
        // 位点越界到末尾之后：消费者已经跳过全部现存消息，滞后就是 0。
        assert_eq!(partition_lag(500, 100, 300), 0);
        // 正常区间内照常相减。
        assert_eq!(partition_lag(150, 100, 300), 150);
        // 空分区（low == high）没有滞后可言。
        assert_eq!(partition_lag(42, 7, 7), 0);
    }

    /// 成员分配字节：按 Kafka 基础类型写一段 `[(topic, [partition])]`。
    fn encode_assignment(topics: &[(&str, &[i32])]) -> Vec<u8> {
        let mut out = (topics.len() as i32).to_be_bytes().to_vec();
        for (topic, partitions) in topics {
            let name = topic.as_bytes();
            out.extend_from_slice(&(name.len() as i16).to_be_bytes());
            out.extend_from_slice(name);
            out.extend_from_slice(&(partitions.len() as i32).to_be_bytes());
            for partition in *partitions {
                out.extend_from_slice(&partition.to_be_bytes());
            }
        }
        out
    }

    /// 用一个假成员 ID 走一遍 `assemble_assignment` 需要的判定。
    ///
    /// `GroupInfo` 只能由 librdkafka 构造，这里把它的两条判定（按协议类型分流、
    /// 把字节交给领域层）就地重演一遍 —— 目的只是钉住「协议不是 consumer 时
    /// 不给分区归属」这条规则。
    fn assignment_of(protocol_type: &str, payload: Vec<u8>) -> GroupAssignment {
        if !protocol_type.eq_ignore_ascii_case("consumer") {
            return crate::domain::group_assignment_unavailable(protocol_type);
        }
        crate::domain::assemble_group_assignment(vec![("member-1".to_owned(), payload)])
    }

    #[test]
    fn non_consumer_group_has_no_partition_ownership() {
        // Kafka Connect / 事务协调器这类组自己定义消息格式，硬解出来是垃圾。
        let result = assignment_of("connect", encode_assignment(&[("orders", &[0])]));
        assert!(result.by_member.is_empty());
        assert!(
            result.notes.iter().any(|note| note.contains("connect")),
            "{:?}",
            result.notes
        );
    }

    #[test]
    fn consumer_protocol_decodes_partitions() {
        let result = assignment_of("consumer", encode_assignment(&[("orders", &[0, 2])]));
        assert_eq!(result.by_member.len(), 1);
        assert_eq!(result.of("member-1").len(), 2);
        assert!(result.notes.is_empty(), "{:?}", result.notes);
    }

    #[test]
    fn limit_is_clamped() {
        assert_eq!(clamp_limit(None), DEFAULT_GROUP_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(usize::MAX)), MAX_GROUP_LIMIT);
    }
}
