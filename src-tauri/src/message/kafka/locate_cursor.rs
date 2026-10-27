//! 定位续扫游标。
//!
//! 定位是一次有上限的顺序扫描，「继续往下扫」不能靠「再跑一次同样的条件」——
//! 那会把已经看过的那一段重新读一遍，越翻越慢，且翻到第 N 页就要付 N 次代价。
//! 所以必须记住**每个分区读到哪**，下次从那里接着读。
//!
//! 游标的三个组成缺一不可：
//!
//! 1. 下一段扫描的起点：每个分区的下一条 offset。正向是 `上次末尾 + 1`；
//!    反向是「分区内从旧往新读到哪」，下次只处理该位置之前的部分。
//! 2. 方向与前一段是否已经走完：反向扫描要先读到分区旧端才算结束。
//! 3. 条件指纹：key / after / before 变了，旧游标必须作废——
//!    否则「改条件后再点一次」会从半截开始扫，结果既不像新查询也不像续扫。
//! 4. 容量：每页条数决定**每个分区一次读多少**，因此也进指纹。它变了不叫
//!    「条件变化」，叫「这一页要重新分配」——两件事的界面文案完全不同
//!    （见 `CursorStatus::Resized`）。
//!
//! 全部是纯函数，编码成一行文本交给前端原样回传；前端不需要理解内部结构。

use serde::{Deserialize, Serialize};

use crate::domain::MessageLocate;

/// 条件指纹里「扫描范围」那一段：目标 / key / 时间区间。
///
/// 这一段变化等于换了一个查询，旧游标必须整份作废，并且要在界面上说
/// 「条件已变化，本次从头扫描」。
pub fn scope_of(request: &MessageLocate) -> String {
    let key = request
        .key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    format!(
        "{}|{}|{}|{}",
        request.target.trim(),
        key,
        request
            .after
            .map_or_else(|| "-".to_owned(), |value| value.to_string()),
        request
            .before
            .map_or_else(|| "-".to_owned(), |value| value.to_string()),
    )
}

/// 每页条数在指纹里怎么表示。
///
/// 它以前不进指纹，理由是「只决定一次给多少条」。可它同时决定了
/// `split_quota` 给每个方向分多少、以及一次扫描在每个分区读多远，
/// 所以它变了之后继续用旧游标，续出来的是一份「按旧预算切了一半」的结果。
///
/// 用「粗档」而不是原值：一次定位要么读满、要么从头再来，读满时第一页的
/// 条数确实就是每页上限；只读到几条时提前停下的位置与上限没什么关系
/// （时间预算、分区读空都会让它提前收手）。按原值进指纹会把「50 改 100」
/// 这种必然要重扫的情况当成续扫，把「100 改 60」这种本来能续的情况判成作废。
/// 粗档让第二个场景保住结果，第一个场景老老实实重扫。
pub fn capacity_of(limit: usize) -> usize {
    let step = CAPACITY_STEP;
    let bucket = limit / step;
    if bucket == 0 { limit } else { bucket * step }
}

/// 容量粗档的粒度：见 `capacity_of`。
const CAPACITY_STEP: usize = 50;

/// 条件指纹：`范围|每页条数`。
///
/// 两段拼在一起是因为它们是同一份游标的两条前提：范围决定「扫哪儿」，
/// 容量决定「一次扫多少」。任何一条变了，续扫的位置都不再成立。
pub fn fingerprint(request: &MessageLocate) -> String {
    format!(
        "{}|{}",
        scope_of(request),
        capacity_of(request.limit.unwrap_or(0))
    )
}

/// 分区游标的原子状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartitionCursor {
    pub partition: i32,
    /// 下一次该读的 offset（含）。
    pub next: i64,
    /// 这个分区是否已经读完。
    pub done: bool,
}

/// 解码后的游标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocateCursor {
    pub fingerprint: String,
    /// 方向：`f` 正向（从旧到新）、`b` 反向（从新到旧）。
    pub backward: bool,
    pub partitions: Vec<PartitionCursor>,
}

impl LocateCursor {
    /// 编码成一行文本：`v1|b|<指纹>|<分区:offset[:d]>,...`
    ///
    /// 指纹里的 `|` 会破坏分段，所以编码前替换掉。指纹本身只用于相等比较，
    /// 替换不会造成误判（原文不会再出现在同一位置）。
    pub fn encode(&self) -> String {
        let partitions = self
            .partitions
            .iter()
            .map(|item| {
                if item.done {
                    format!("{}:{}:d", item.partition, item.next)
                } else {
                    format!("{}:{}", item.partition, item.next)
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "v1|{}|{}|{}",
            if self.backward { "b" } else { "f" },
            self.fingerprint.replace('|', "\u{1}").replace(',', "\u{2}"),
            partitions
        )
    }

    /// 解码。任何形状不对的输入都返回 `None`，调用方当作「没有游标」从头扫。
    ///
    /// 游标是前端回传的不可信输入：宁可多扫一遍，也不要按一个半坏的游标
    /// 从某个诡异的 offset 开始读。
    pub fn decode(raw: &str) -> Option<Self> {
        let mut parts = raw.split('|');
        if parts.next()? != "v1" {
            return None;
        }
        let backward = match parts.next()? {
            "b" => true,
            "f" => false,
            _ => return None,
        };
        let fingerprint = parts.next()?.replace('\u{1}', "|").replace('\u{2}', ",");
        let raw_partitions = parts.next()?;

        let mut partitions = Vec::new();
        if !raw_partitions.is_empty() {
            for item in raw_partitions.split(',') {
                let mut fields = item.split(':');
                let partition = fields.next()?.parse().ok()?;
                let next = fields.next()?.parse().ok()?;
                let done = match fields.next() {
                    None => false,
                    Some("d") => true,
                    Some(_) => return None,
                };
                partitions.push(PartitionCursor {
                    partition,
                    next,
                    done,
                });
            }
        }

        Some(Self {
            fingerprint,
            backward,
            partitions,
        })
    }
}

/// 游标与当前请求的关系。
///
/// 分三种而不是一个布尔值，是因为「没有游标」和「游标作废」在界面上要说的话
/// 完全不同：前者是首次扫描，后者必须告诉用户「条件变了，我从头再扫一遍」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorStatus {
    /// 请求里没有游标，或者游标是一段无法解析的垃圾。
    Absent,
    /// 能解析，扫描范围对得上，但每页条数（容量）与当前请求不在同一档。
    ///
    /// 与 `Stale` 分开是因为要说的话不一样：条件没变，只是这一页装不装得下
    /// 上一页留下的进度。说成「条件已变化」会让用户以为自己填错了。
    Resized,
    /// 能解析，但扫描范围对不上。
    Stale,
    /// 与该请求配套，可以续扫。
    Fresh,
}

impl CursorStatus {
    /// 判定游标与当前请求的关系。
    ///
    /// `scope` 与 `capacity` 分别对应 `scope_of` / `capacity_of`：
    /// 指纹本身是两段拼起来的，这里拆开比，才能分辨「条件变了」与「条数变了」。
    pub fn of(raw: Option<&str>, scope: &str, capacity: usize) -> Self {
        let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
            return Self::Absent;
        };
        let Some(cursor) = LocateCursor::decode(raw) else {
            return Self::Absent;
        };
        let expected = format!("{scope}|{capacity}");
        if cursor.fingerprint == expected {
            return Self::Fresh;
        }
        // 老游标（指纹里只有范围、没有容量段）同样落到这里：
        // 它至少还能说清「条件是那一组」，只是容量未知。
        match cursor.fingerprint.rsplit_once('|') {
            Some((old_scope, _)) if old_scope == scope => Self::Resized,
            _ => Self::Stale,
        }
    }
}

/// 续扫起点：把游标里的分区状态翻译成「每个分区从哪里读、边界在哪」。
pub struct Resume {
    /// 未读完的分区及其读取起点。
    pub starts: Vec<(i32, i64)>,
    /// 已经读完的分区，本次不再分配。
    pub exhausted: Vec<i32>,
}

/// 从游标中取出仍然有效的起点。
///
/// 只保留同时满足两个条件的条目：分区至今仍存在（`partitions`），
/// 且未读完。分区被删除后游标里的条目自然失效，不该报错，
/// 也不该把它当成「还在读」——按剩余分区继续是最贴近事实的处理。
pub fn resume(cursor: &LocateCursor, partitions: &[i32]) -> Resume {
    let mut starts = Vec::new();
    let mut exhausted = Vec::new();
    for item in &cursor.partitions {
        if !partitions.contains(&item.partition) {
            continue;
        }
        if item.done {
            exhausted.push(item.partition);
        } else {
            starts.push((item.partition, item.next));
        }
    }
    starts.sort_by_key(|(partition, _)| *partition);
    exhausted.sort_unstable();
    Resume { starts, exhausted }
}

/// 从头扫描时给每个分区的初始起点。
///
/// - 正向：有 `after` 就按时间反查（由调用方给 `resolve_time` 的结果），否则从 `low`；
/// - 反向：总是从 `high - 1` 开始，一路读到 `low`。
///
/// 空分区（`low >= high`）直接标记为已完成，不占一次分配。
pub fn initial_starts(
    partitions: &[(i32, i64, i64)],
    backward: bool,
    resolve_time: impl Fn(i32, i64) -> i64,
    after: Option<i64>,
) -> Vec<PartitionCursor> {
    partitions
        .iter()
        .map(|(partition, low, high)| {
            let empty = low >= high;
            let next = if empty {
                *low
            } else if backward {
                high - 1
            } else {
                match after {
                    Some(after) => resolve_time(*partition, after).clamp(*low, *high),
                    None => *low,
                }
            };
            let done = empty
                || if backward {
                    // 反向读到 low 之前就算读完。
                    next < *low
                } else {
                    next >= *high
                };
            PartitionCursor {
                partition: *partition,
                next,
                done,
            }
        })
        .collect()
}

/// 根据本次读到的位置推进分区状态。
///
/// 正向：`read` 是分区内已读到的最大 offset，下一条从它 +1 开始；读到 `high` 即完成。
/// 反向：`read` 是分区内已读过的最小 offset，下一条从它 -1 开始；读到 `low` 即完成。
///
/// `read` 为 `None` 表示这个分区本次一条都没读到（被条数上限截断在别处），
/// 位置不该倒退，保持原样。
pub fn advance(
    cursor: &mut PartitionCursor,
    read: Option<i64>,
    low: i64,
    high: i64,
    backward: bool,
) {
    let Some(read) = read else {
        return;
    };
    if backward {
        cursor.next = read - 1;
        cursor.done = cursor.next < low;
    } else {
        cursor.next = read + 1;
        cursor.done = cursor.next >= high;
    }
    if cursor.done {
        cursor.next = if backward { low } else { high };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(key: Option<&str>, after: Option<i64>, before: Option<i64>) -> MessageLocate {
        MessageLocate {
            connection_id: "c1".to_owned(),
            target: "orders".to_owned(),
            key: key.map(str::to_owned),
            content: None,
            after,
            before,
            limit: Some(50),
            cursor: None,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let cursor = LocateCursor {
            fingerprint: fingerprint(&request(Some("order-1"), Some(1000), None)),
            backward: true,
            partitions: vec![
                PartitionCursor {
                    partition: 0,
                    next: 42,
                    done: false,
                },
                PartitionCursor {
                    partition: 3,
                    next: 7,
                    done: true,
                },
            ],
        };
        let decoded = LocateCursor::decode(&cursor.encode()).expect("解码失败");
        assert_eq!(decoded, cursor);
    }

    #[test]
    fn fingerprint_survives_separator_characters() {
        // 指纹里同时出现 `|` 和 `,`，编码后仍要能原样还原。
        let crazy = MessageLocate {
            target: "a|b,c".to_owned(),
            key: Some("k|,k".to_owned()),
            ..request(None, None, None)
        };
        let cursor = LocateCursor {
            fingerprint: fingerprint(&crazy),
            backward: false,
            partitions: vec![PartitionCursor {
                partition: 1,
                next: 5,
                done: false,
            }],
        };
        let decoded = LocateCursor::decode(&cursor.encode()).expect("解码失败");
        assert_eq!(decoded.fingerprint, fingerprint(&crazy));
    }

    /// 一次定位请求的「范围 + 容量」，即 `CursorStatus::of` 的两个入参。
    fn key_of(request: &MessageLocate) -> (String, usize) {
        (scope_of(request), capacity_of(request.limit.unwrap_or(0)))
    }

    #[test]
    fn cursor_status_tells_absent_from_stale() {
        // 前端把「加载更多」当成「重新定位」时会把上一页的游标带到新条件上，
        // 这条路径必须说成「条件已变化」，而不是「首次扫描」。
        let first = request(None, None, None);
        let cursor = LocateCursor {
            fingerprint: fingerprint(&first),
            backward: false,
            partitions: vec![PartitionCursor {
                partition: 0,
                next: 5,
                done: false,
            }],
        }
        .encode();

        let (scope, capacity) = key_of(&first);
        assert_eq!(
            CursorStatus::of(Some(&cursor), &scope, capacity),
            CursorStatus::Fresh
        );

        let (scope, capacity) = key_of(&request(Some("order-1"), None, None));
        assert_eq!(
            CursorStatus::of(Some(&cursor), &scope, capacity),
            CursorStatus::Stale
        );

        // 没有游标 / 空串 / 垃圾：都按「没有游标」处理，不该说成条件变了。
        let (scope, capacity) = key_of(&first);
        assert_eq!(
            CursorStatus::of(None, &scope, capacity),
            CursorStatus::Absent
        );
        assert_eq!(
            CursorStatus::of(Some(""), &scope, capacity),
            CursorStatus::Absent
        );
        assert_eq!(
            CursorStatus::of(Some("v9|||"), &scope, capacity),
            CursorStatus::Absent
        );
    }

    #[test]
    fn wider_page_invalidates_cursor_but_keeps_scope_message() {
        // 关键回归：每页条数以前不进指纹，于是「同一条件放宽/收窄条数」
        // 会拿上一页的游标当续页，交出一份按旧预算切了一半的结果。
        //
        // 这里断言的不是「作废」，而是**作废的理由**：条件没变，只是页面容量变了，
        // 说成「条件已变化」会让人以为自己填错了条件。
        let narrow = request(None, None, None); // limit 50
        let cursor = LocateCursor {
            fingerprint: fingerprint(&narrow),
            backward: false,
            partitions: vec![PartitionCursor {
                partition: 0,
                next: 5,
                done: false,
            }],
        }
        .encode();

        // 同一档（50 → 70，档位都是 50）：续扫照旧。
        let mut same_bucket = request(None, None, None);
        same_bucket.limit = Some(70);
        let (scope, capacity) = key_of(&same_bucket);
        assert_eq!(
            CursorStatus::of(Some(&cursor), &scope, capacity),
            CursorStatus::Fresh
        );

        // 跨档（50 → 200）：作废，理由要说「条数变了」而不是「条件变了」。
        let mut wider = request(None, None, None);
        wider.limit = Some(200);
        let (scope, capacity) = key_of(&wider);
        assert_eq!(
            CursorStatus::of(Some(&cursor), &scope, capacity),
            CursorStatus::Resized
        );

        // 范围也换了，那就真的是条件变化 —— Resized 不能盖住 Stale。
        let changed = request(Some("order-1"), None, None);
        let (scope, capacity) = key_of(&changed);
        assert_eq!(
            CursorStatus::of(Some(&cursor), &scope, capacity),
            CursorStatus::Stale
        );
    }

    #[test]
    fn legacy_cursor_without_capacity_is_resized_not_stale() {
        // 老版本写下的游标指纹里只有范围，没有容量段（`orders||-|-`）。
        // 直接判成「条件已变化」会说错话，判成「作废待重扫」正好。
        let legacy = LocateCursor {
            fingerprint: format!("{}|", scope_of(&request(None, None, None))),
            backward: false,
            partitions: vec![PartitionCursor {
                partition: 0,
                next: 5,
                done: false,
            }],
        }
        .encode();
        let (scope, capacity) = key_of(&request(None, None, None));
        assert_eq!(
            CursorStatus::of(Some(&legacy), &scope, capacity),
            CursorStatus::Resized
        );
    }

    #[test]
    fn capacity_buckets_small_pages_by_value() {
        // 小于一档的条数是精确值：此时「一次给几条」就是页面容量本身。
        assert_eq!(capacity_of(0), 0);
        assert_eq!(capacity_of(20), 20);
        assert_eq!(capacity_of(49), 49);
        // 达到一档就取整到档位下沿。
        assert_eq!(capacity_of(50), 50);
        assert_eq!(capacity_of(99), 50);
        assert_eq!(capacity_of(200), 200);
        assert_eq!(capacity_of(500), 500);
    }

    #[test]
    fn garbage_cursor_is_rejected() {
        for raw in ["", "v2|f||", "v1|x||", "v1|f||0:abc", "v1|f||0:1:x", "v1|f"] {
            assert!(LocateCursor::decode(raw).is_none(), "{raw}");
        }
        // 空分区列表是合法的：所有分区都读完了。
        assert_eq!(
            LocateCursor::decode("v1|f||").map(|item| item.partitions.len()),
            Some(0)
        );
    }

    #[test]
    fn blank_key_and_missing_bounds_share_fingerprint() {
        assert_eq!(
            fingerprint(&request(Some("  "), None, None)),
            fingerprint(&request(None, None, None))
        );
        // 同一档内的条数变化不改变指纹；跨档才变（见 capacity_of 的理由）。
        let mut near = request(None, Some(1), None);
        near.limit = Some(70);
        assert_eq!(
            fingerprint(&request(None, Some(1), None)),
            fingerprint(&near)
        );
        let mut wider = request(None, Some(1), None);
        wider.limit = Some(999);
        assert_ne!(
            fingerprint(&request(None, Some(1), None)),
            fingerprint(&wider)
        );
    }

    #[test]
    fn resume_skips_deleted_and_finished_partitions() {
        let cursor = LocateCursor {
            fingerprint: "x".to_owned(),
            backward: false,
            partitions: vec![
                PartitionCursor {
                    partition: 0,
                    next: 10,
                    done: false,
                },
                PartitionCursor {
                    partition: 1,
                    next: 20,
                    done: true,
                },
                PartitionCursor {
                    partition: 9,
                    next: 30,
                    done: false,
                },
            ],
        };
        let resumed = resume(&cursor, &[0, 1]);
        assert_eq!(resumed.starts, vec![(0, 10)]);
        assert_eq!(resumed.exhausted, vec![1]);
    }

    #[test]
    fn initial_starts_handles_empty_and_bounds() {
        let forward = initial_starts(&[(0, 0, 0), (1, 5, 9)], false, |_, _| 0, None);
        assert!(forward[0].done, "空分区不该被分配");
        assert_eq!(
            forward[1],
            PartitionCursor {
                partition: 1,
                next: 5,
                done: false
            }
        );

        let backward = initial_starts(&[(1, 5, 9)], true, |_, _| 0, None);
        assert_eq!(backward[0].next, 8);

        // 时间反查结果被夹到 [low, high]：区间起点早于日志保留期时不能给出负 offset。
        let clamped = initial_starts(&[(1, 5, 9)], false, |_, _| 0, Some(123));
        assert_eq!(clamped[0].next, 5);
        let clamped = initial_starts(&[(1, 5, 9)], false, |_, _| 99, Some(123));
        assert_eq!(clamped[0].next, 9);
        assert!(clamped[0].done);
    }

    #[test]
    fn advance_moves_forward_and_finishes() {
        let mut cursor = PartitionCursor {
            partition: 0,
            next: 10,
            done: false,
        };
        advance(&mut cursor, Some(12), 0, 20, false);
        assert_eq!(cursor.next, 13);
        assert!(!cursor.done);

        advance(&mut cursor, Some(19), 0, 20, false);
        assert!(cursor.done);
        assert_eq!(cursor.next, 20);
    }

    #[test]
    fn advance_moves_backward_and_finishes() {
        let mut cursor = PartitionCursor {
            partition: 0,
            next: 8,
            done: false,
        };
        advance(&mut cursor, Some(3), 2, 20, true);
        assert_eq!(cursor.next, 2);
        assert!(!cursor.done);

        advance(&mut cursor, Some(2), 2, 20, true);
        assert!(cursor.done);
        assert_eq!(cursor.next, 2);
    }

    #[test]
    fn rescan_after_resume_keeps_moving_forward() {
        // 模拟两页：第一页读到 offset 12，游标写 13；第二页从 13 接着读到 19 后完成。
        let mut state = PartitionCursor {
            partition: 0,
            next: 10,
            done: false,
        };
        advance(&mut state, Some(12), 0, 20, false);
        let cursor = LocateCursor {
            fingerprint: "f".to_owned(),
            backward: false,
            partitions: vec![state],
        };
        let decoded = LocateCursor::decode(&cursor.encode()).expect("解码失败");
        let resumed = resume(&decoded, &[0]);
        assert_eq!(resumed.starts, vec![(0, 13)]);
        assert!(resumed.exhausted.is_empty());

        let mut state = decoded.partitions[0].clone();
        advance(&mut state, Some(19), 0, 20, false);
        assert!(state.done);
        // 读完的分区在下一轮续扫里不会重新分配。
        let finished = LocateCursor {
            fingerprint: "f".to_owned(),
            backward: false,
            partitions: vec![state],
        };
        let resumed = resume(&finished, &[0]);
        assert!(resumed.starts.is_empty());
        assert_eq!(resumed.exhausted, vec![0]);
    }

    #[test]
    fn advance_keeps_position_when_nothing_read() {
        let mut cursor = PartitionCursor {
            partition: 0,
            next: 7,
            done: false,
        };
        advance(&mut cursor, None, 0, 20, false);
        assert_eq!(cursor.next, 7);
        assert!(!cursor.done);
        // 已经读完的分区不会被 None 重新激活。
        cursor.done = true;
        advance(&mut cursor, None, 0, 20, false);
        assert!(cursor.done);
    }
}
