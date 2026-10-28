//! 消费组成员的分区归属：把 librdkafka 给出的成员分配字节解成「谁负责哪些分区」。
//!
//! 面板原先只有「组里有哪些成员」和「各分区滞后多少」，两张表各自都对，
//! 合起来看却是空的：**滞后 12 万的那几个分区，究竟压在谁身上？**
//! 没有这一列，队头阻塞只能猜（`group_block` 里那句「归属一栏留空」就是那时候的债）。
//!
//! ## 解的是什么格式
//!
//! 消费者协议的 `MemberAssignment` 是一个数组，元素是 `(topic, [partition...])`，
//! 用 Kafka 的基础类型编码写成（big-endian，字符串带两个字节长度前缀）。
//! 只解这一层，不碰任何分组逻辑 —— 谁配出这份分配是 broker 的事。
//!
//! ## 三种「读不到」必须分开说
//!
//! - **没分配**：成员在线、协议是 `consumer`，但分配是空数组。这不正常，
//!   要么正在再均衡，要么这个成员刚加入还没收到分配。
//! - **读不懂**：字节断在半个字符串上、长度前缀是负数、分区号是负数。
//!   那是数据坏了，不是「没有分配」—— 混成一句「暂无」会让人以为一切正常。
//! - **不适用**：协议的 `protocol_type` 不是 `consumer`（Kafka Connect、事务协调器
//!   之类的组自己定义消息格式）。这种情况不该猜，也不该报警，只说明「这类组没有分区归属」。
//!
//! 这一层不碰网络、不碰 FFI，字节切片进、模型出。

use serde::{Deserialize, Serialize};

/// 一个成员负责的分区。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedPartition {
    pub topic: String,
    pub partition: i32,
}

impl AssignedPartition {
    /// 展示用的短标签，形如 `orders-3`、`orders-P3`。
    pub fn label(&self) -> String {
        format!("{}-P{}", self.topic, self.partition)
    }
}

/// 解析结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupAssignment {
    /// 成员 → 分区。键是 `member_id`，与 `ConsumerGroupMember::member_id` 同一套取值。
    #[serde(default)]
    pub by_member: Vec<MemberAssignment>,
    /// 需要用户知道的事实（读不懂、重复归属、协议不适用）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl GroupAssignment {
    fn empty() -> Self {
        Self {
            by_member: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// 某个成员的分区；没有记录时返回空切片（不是「读不懂」）。
    pub fn of(&self, member_id: &str) -> &[AssignedPartition] {
        self.by_member
            .iter()
            .find(|item| item.member_id == member_id)
            .map_or(&[], |item| item.partitions.as_slice())
    }
}

/// 单个成员的归属。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberAssignment {
    pub member_id: String,
    /// 成员负责的分区，已按 `(topic, partition)` 排序去重。
    #[serde(default)]
    pub partitions: Vec<AssignedPartition>,
    /// 分配字节的解析结论。
    pub state: AssignmentState,
    /// 解析失败时的原因，直接给用户看。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// 一次分配的解析结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssignmentState {
    /// 解析成功且至少有一个分区。
    Assigned,
    /// 解析成功但一个分区都没有（再均衡中、或刚加入还没收到分配）。
    Empty,
    /// 字节读不懂。分区归属未知 —— 不是「没有分区」。
    Broken,
}

/// 解析错误的内部表示：区分「字节不够」与「字节不合规」，都算 `Broken`，
/// 但说明要给得具体，否则用户只会去重启消费者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// 数据在中途结束。通常是分区正在再均衡时读到的半截快照。
    Truncated { wanted: usize, left: usize },
    /// 长度前缀或分区号为负/越界。
    Invalid(String),
}

impl DecodeError {
    /// 给用户看的一句话。
    pub fn describe(&self) -> String {
        match self {
            Self::Truncated { wanted, left } => format!(
                "分配数据不完整（还需要 {wanted} 字节，实际只剩 {left} 字节）：多半是读到了再均衡中的半截快照，刷新一次即可"
            ),
            Self::Invalid(reason) => format!("分配数据不合规：{reason}"),
        }
    }
}

/// 解析一个成员的 `MemberAssignment`。
///
/// 空字节切片（`assignment()` 返回 `None` 时上层传空）算 `Empty`：
/// 那确实没有分区，不是读坏了。
pub fn decode(member_id: &str, bytes: &[u8]) -> MemberAssignment {
    match parse(bytes) {
        Ok(partitions) if partitions.is_empty() => MemberAssignment {
            member_id: member_id.to_owned(),
            partitions: Vec::new(),
            state: AssignmentState::Empty,
            problem: None,
        },
        Ok(partitions) => MemberAssignment {
            member_id: member_id.to_owned(),
            partitions,
            state: AssignmentState::Assigned,
            problem: None,
        },
        Err(error) => MemberAssignment {
            member_id: member_id.to_owned(),
            partitions: Vec::new(),
            state: AssignmentState::Broken,
            problem: Some(error.describe()),
        },
    }
}

/// 解出 `[(topic, [partition])]`。
pub fn parse(bytes: &[u8]) -> Result<Vec<AssignedPartition>, DecodeError> {
    let mut cursor = Cursor::new(bytes);
    let topic_count = cursor.array_len()?;
    let mut out: Vec<AssignedPartition> = Vec::new();

    for _ in 0..topic_count {
        let topic = cursor.string()?;
        let partition_count = cursor.array_len()?;
        for _ in 0..partition_count {
            let partition = cursor.i32()?;
            if partition < 0 {
                return Err(DecodeError::Invalid(format!(
                    "主题 {topic} 上出现了负数分区号 {partition}"
                )));
            }
            out.push(AssignedPartition {
                topic: topic.clone(),
                partition,
            });
        }
    }

    // 尾部多出来的字节说明我们的读法和服务端的写法不一致。
    // 分区归属是排障依据，宁可报「读不懂」也不从错位的字节里猜。
    if !cursor.at_end() {
        return Err(DecodeError::Invalid(format!(
            "解析完成后还剩 {} 字节未消费",
            cursor.left()
        )));
    }

    out.sort();
    out.dedup();
    Ok(out)
}

/// 组装整组结果：解析每个成员，并把「同一个分区挂在两个成员上」说出来。
///
/// 重复归属是再均衡过程中真实存在的瞬时状态（旧成员还没交还、新成员已经拿到）。
/// 它不该被静默去重 —— 那会让「谁真正在读这个分区」变得不可知。
pub fn assemble(members: Vec<(String, Vec<u8>)>) -> GroupAssignment {
    let mut result = GroupAssignment::empty();
    for (member_id, bytes) in members {
        result.by_member.push(decode(&member_id, &bytes));
    }

    let mut seen: Vec<(AssignedPartition, String)> = Vec::new();
    let mut duplicates: Vec<String> = Vec::new();
    for entry in &result.by_member {
        for partition in &entry.partitions {
            if let Some((_, owner)) = seen.iter().find(|(item, _)| item == partition) {
                duplicates.push(format!(
                    "{} 同时出现在成员 {owner} 与 {} 上",
                    partition.label(),
                    entry.member_id
                ));
            } else {
                seen.push((partition.clone(), entry.member_id.clone()));
            }
        }
    }
    if !duplicates.is_empty() {
        duplicates.sort();
        duplicates.dedup();
        result.notes.push(format!(
            "有分区被重复分配（多半是再均衡还没落定）：{}",
            duplicates.join("；")
        ));
    }

    let broken = result
        .by_member
        .iter()
        .filter(|item| item.state == AssignmentState::Broken)
        .count();
    if broken > 0 {
        result.notes.push(format!(
            "有 {broken} 个成员的分配读不懂，这些成员的分区归属是未知，不是「没有分区」"
        ));
    }

    result
}

/// 协议的 `protocol_type` 不是 `consumer` 时用的结论：不猜、不报警，只说明。
pub fn not_consumer_protocol(protocol_type: &str) -> GroupAssignment {
    let mut result = GroupAssignment::empty();
    let kind = if protocol_type.trim().is_empty() {
        "未声明协议类型".to_owned()
    } else {
        format!("协议类型是 {protocol_type}")
    };
    result.notes.push(format!(
        "{kind}，不是消费者协议 —— 这类组没有「分区归属」这回事"
    ));
    result
}

/// 只前进的字节游标。
struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn left(&self) -> usize {
        self.bytes.len().saturating_sub(self.pos)
    }

    fn at_end(&self) -> bool {
        self.left() == 0
    }

    fn take(&mut self, wanted: usize) -> Result<&'a [u8], DecodeError> {
        if self.left() < wanted {
            return Err(DecodeError::Truncated {
                wanted,
                left: self.left(),
            });
        }
        let slice = &self.bytes[self.pos..self.pos + wanted];
        self.pos += wanted;
        Ok(slice)
    }

    fn i16(&mut self) -> Result<i16, DecodeError> {
        let raw = self.take(2)?;
        Ok(i16::from_be_bytes([raw[0], raw[1]]))
    }

    fn i32(&mut self) -> Result<i32, DecodeError> {
        let raw = self.take(4)?;
        Ok(i32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
    }

    /// 数组长度前缀。负数表示 null 数组，按空处理。
    fn array_len(&mut self) -> Result<usize, DecodeError> {
        let len = self.i32()?;
        if len < 0 {
            // null 数组只在极罕见的旧客户端上出现，当成 0 更接近事实。
            return Ok(0);
        }
        Ok(len as usize)
    }

    /// 字符串：两个字节长度前缀（含 null 的负数）。
    fn string(&mut self) -> Result<String, DecodeError> {
        let len = self.i16()?;
        if len < 0 {
            return Ok(String::new());
        }
        let raw = self.take(len as usize)?;
        String::from_utf8(raw.to_vec())
            .map_err(|_| DecodeError::Invalid("主题名不是合法的 UTF-8".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按 Kafka 基础类型写一段分配字节。
    fn encode(topics: &[(&str, &[i32])]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(topics.len() as i32).to_be_bytes());
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

    #[test]
    fn parses_single_topic_assignment() {
        let bytes = encode(&[("orders", &[0, 1, 2])]);
        let parsed = parse(&bytes).expect("解析成功");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].topic, "orders");
        assert_eq!(parsed[2].partition, 2);
    }

    #[test]
    fn parses_multiple_topics_in_label_order() {
        let bytes = encode(&[("payments", &[1]), ("orders", &[3, 0])]);
        let entry = decode("consumer-1", &bytes);
        assert_eq!(entry.state, AssignmentState::Assigned);
        assert_eq!(
            entry.partitions,
            vec![
                AssignedPartition {
                    topic: "orders".to_owned(),
                    partition: 0
                },
                AssignedPartition {
                    topic: "orders".to_owned(),
                    partition: 3
                },
                AssignedPartition {
                    topic: "payments".to_owned(),
                    partition: 1
                },
            ]
        );
    }

    #[test]
    fn empty_assignment_is_empty_not_broken() {
        // 空数组：成员在线但一个分区都没分到。
        let entry = decode("consumer-1", &0i32.to_be_bytes());
        assert_eq!(entry.state, AssignmentState::Empty);
        assert_eq!(entry.problem, None);

        // 完全没有字节，同样是「没有分配」。
        let none = decode("consumer-2", &[]);
        assert_eq!(none.state, AssignmentState::Broken);
        assert!(none.problem.is_some(), "连长度前缀都没有，不能当成空");
    }

    #[test]
    fn truncated_bytes_are_reported_as_broken_with_reason() {
        let bytes = encode(&[("orders", &[0, 1])]);
        let entry = decode("consumer-1", &bytes[..7]);
        assert_eq!(entry.state, AssignmentState::Broken);
        let problem = entry.problem.expect("要有原因");
        assert!(problem.contains("不完整"), "{problem}");
    }

    #[test]
    fn negative_partition_is_rejected() {
        let bytes = encode(&[("orders", &[-1])]);
        let entry = decode("consumer-1", &bytes);
        assert_eq!(entry.state, AssignmentState::Broken);
        assert!(
            entry.problem.unwrap().contains("负数分区号"),
            "负数分区号要单独说明"
        );
    }

    #[test]
    fn trailing_bytes_are_rejected_instead_of_guessed() {
        let mut bytes = encode(&[("orders", &[0])]);
        bytes.push(0x7f);
        let entry = decode("consumer-1", &bytes);
        assert_eq!(entry.state, AssignmentState::Broken);
    }

    #[test]
    fn duplicate_partition_across_members_is_called_out() {
        let first = encode(&[("orders", &[0, 1])]);
        let second = encode(&[("orders", &[1, 2])]);
        let result = assemble(vec![("a".to_owned(), first), ("b".to_owned(), second)]);
        assert_eq!(result.by_member.len(), 2);
        assert!(
            result.notes.iter().any(|note| note.contains("orders-P1")),
            "{:?}",
            result.notes
        );
    }

    #[test]
    fn broken_member_adds_a_note() {
        let result = assemble(vec![("a".to_owned(), vec![0, 0, 0, 9])]);
        assert!(
            result.notes.iter().any(|note| note.contains("读不懂")),
            "{:?}",
            result.notes
        );
        assert!(result.of("a").is_empty());
    }

    #[test]
    fn non_consumer_protocol_is_explained_not_flagged() {
        let result = not_consumer_protocol("connect");
        assert!(result.by_member.is_empty());
        assert_eq!(result.notes.len(), 1);
        assert!(result.notes[0].contains("connect"));
    }

    #[test]
    fn of_returns_empty_for_unknown_member() {
        let result = assemble(vec![("a".to_owned(), encode(&[("t", &[0])]))]);
        assert_eq!(result.of("a").len(), 1);
        assert!(result.of("nobody").is_empty());
    }

    #[test]
    fn label_is_readable() {
        let partition = AssignedPartition {
            topic: "orders".to_owned(),
            partition: 7,
        };
        assert_eq!(partition.label(), "orders-P7");
    }
}
