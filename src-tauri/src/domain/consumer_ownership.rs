//! 队列级消费者归属：把「谁在消费这个队列」从三张表拼回一句话。
//!
//! ## 这一屏补的是哪半句话
//!
//! 消费者页已经回答了「每个队列上有几个消费者、预取塞满没有」。它回答不了的
//! 是排查时最要紧的那句：**这条连接到底占了什么**。
//!
//! 同一条连接常常开着几十个 channel，每个 channel 又各自 `basic.consume` 几个队列。
//! 于是三张表彼此对不上号：
//!
//! - `/api/consumers` 说「这个队列有 3 个消费者」，但不说是哪台机器；
//! - `/api/connections` 说「这条连接开了 12 个 channel」，但不说它们在消费什么；
//! - `/api/channels` 说「这个 channel 有 2 个消费者」，但不说它们是谁的。
//!
//! 断开一个消费者的时候，这件事立刻变得要命：你踢掉的可能是自己监控进程的
//! 最后一个消费者，也可能是业务服务的 12 个 channel 里唯一在干活的那个。
//!
//! ## 判读规则全在这里
//!
//! 「独占」「无预取上限」「同一条连接占了多个队列」这类判断都不碰网络，
//! 所以可以脱库单测。前端对应 `src/lib/consumer-ownership.ts`。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::consumer_link::{ConsumerHealth, QueueConsumer, judge};

/// 一个消费者在「连接 → channel → 队列」这条链路上的完整位置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerOwner {
    pub queue: String,
    pub consumer_tag: String,
    /// 连接名。管理 API 不给时是空串，界面上要显示成「未知连接」而不是一片空白。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    /// 客户端上报的连接名（`client_properties.connection_name`），排查时比服务端名字有用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    /// channel 名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    pub username: String,
    pub prefetch_count: u32,
    pub messages_unacknowledged: u64,
    pub ack_required: bool,
    pub health: ConsumerHealth,
    /// 这条连接上的对端地址，形如 `10.0.0.1:52312`。
    ///
    /// 「哪个 pod 在消费」这个问题只能靠它回答：连接名和 channel 名都是服务端
    /// 生成的，重启一次就变。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    /// 这条连接是不是已经不在运行（`blocking` / `closing` 等）。
    ///
    /// 消费者还挂在列表上、连接却已经阻塞 —— 这是「看起来有人在消费，
    /// 消息却不动」最直接的解释。
    #[serde(default)]
    pub connection_blocked: bool,
}

impl ConsumerOwner {
    /// 展示用的连接名：优先客户端上报的名字，其次服务端生成的，最后给一句话。
    pub fn connection_label(&self) -> &str {
        self.client_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .or(self.connection.as_deref().filter(|name| !name.is_empty()))
            .unwrap_or("未知连接")
    }

    /// 这个消费者该不该在界面上被标出来。
    pub fn is_unhealthy(&self) -> bool {
        self.health != ConsumerHealth::Healthy || self.connection_blocked
    }
}

/// 一个队列上的归属汇总。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueOwnership {
    pub queue: String,
    /// 待消费条数。
    pub messages_ready: u64,
    pub messages_unacknowledged: u64,
    pub owners: Vec<ConsumerOwner>,
    /// 涉及几条不同的连接。**这才是「有几个消费者」真正想问的数字**：
    /// 一个服务的 12 个 channel 是 12 个消费者，但只有 1 条连接。
    pub connections: usize,
    /// 涉及几个不同的账号。
    pub users: usize,
    /// 有没有预取塞满或连接阻塞的。
    pub troubled: usize,
}

impl QueueOwnership {
    /// 有堆积却一个消费者都没有：消息进来就再也不会出去。
    pub fn is_unconsumed(&self) -> bool {
        self.owners.is_empty() && self.messages_ready > 0
    }

    /// 一条排队等消费的队列被多个连接共享吗。
    ///
    /// 单连接独占是常见的「一个服务吃掉整个队列」—— 它本身不一定有问题，
    /// 但扩容时最想知道的就是这个数字为什么一直是 1。
    pub fn is_single_connection(&self) -> bool {
        self.connections == 1 && !self.owners.is_empty()
    }

    /// 一句话结论，写在卡片标题上。
    pub fn verdict(&self) -> String {
        if self.owners.is_empty() {
            return if self.messages_ready > 0 {
                format!("没人消费，堆着 {} 条", self.messages_ready)
            } else {
                "没人消费（队列是空的）".to_owned()
            };
        }
        let mut parts = vec![format!(
            "{} 个消费者 / {} 条连接",
            self.owners.len(),
            self.connections
        )];
        if self.is_single_connection() {
            parts.push("单连接独占".to_owned());
        }
        if self.troubled > 0 {
            parts.push(format!("{} 个有异常", self.troubled));
        }
        parts.join(" · ")
    }
}

/// 一个账号被谁在用：同一个人开的连接可能散在好几个服务里。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOwnership {
    pub username: String,
    pub connections: usize,
    pub consumers: usize,
    pub queues: Vec<String>,
    /// 这个账号消费的所有队列上的待消费总量。
    pub messages_ready: u64,
}

/// 整份归属快照。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipSnapshot {
    pub queues: Vec<QueueOwnership>,
    /// 按账号汇总。同一套凭证被多个服务共用是最常见的越权来源。
    pub users: Vec<UserOwnership>,
    /// 有消费者、但连接已经不在运行的条数。
    pub blocked_consumers: usize,
    /// 需要用户知道的事实。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

impl OwnershipSnapshot {
    /// 一句话结论。
    pub fn verdict(&self) -> String {
        let consumers: usize = self.queues.iter().map(|item| item.owners.len()).sum();
        if consumers == 0 {
            // 一个消费者都没有时，「几个队列堆着消息」比「没有任何消费者」有用得多 ——
            // 后者听起来像「这集群是空的」。
            let waiting = self
                .queues
                .iter()
                .filter(|item| item.is_unconsumed())
                .count();
            return if waiting > 0 {
                format!("没有任何消费者：{waiting} 个队列堆着消息没人消费")
            } else {
                "没有任何消费者".to_owned()
            };
        }
        let connections: BTreeSet<&str> = self
            .queues
            .iter()
            .flat_map(|item| item.owners.iter())
            .map(|owner| owner.connection_label())
            .collect();
        let unconsumed = self
            .queues
            .iter()
            .filter(|item| item.is_unconsumed())
            .count();
        let mut text = format!(
            "{consumers} 个消费者 / {} 条连接 / {} 个账号",
            connections.len(),
            self.users.len()
        );
        if unconsumed > 0 {
            text.push_str(&format!("，{unconsumed} 个队列有堆积却没人消费"));
        }
        if self.blocked_consumers > 0 {
            text.push_str(&format!(
                "，{} 个消费者的连接已阻塞",
                self.blocked_consumers
            ));
        }
        text
    }

    /// 单连接独占的队列。
    pub fn single_connection_queues(&self) -> Vec<&QueueOwnership> {
        self.queues
            .iter()
            .filter(|item| item.is_single_connection())
            .collect()
    }
}

/// 连接侧的信息，用来把消费者挂回「哪台机器、哪个账号」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionFacts {
    pub name: String,
    pub client_name: String,
    pub user: String,
    pub peer: String,
    pub blocked: bool,
}

/// channel 侧的信息，用来补齐消费者缺的 user / connection。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelFacts {
    pub name: String,
    pub connection: String,
    pub user: String,
}

/// 组装一份归属快照。
///
/// 队列的堆积量由调用方给（`/api/queues`），消费者来自 `/api/consumers`，
/// 连接与 channel 是补充信息 —— 缺了也能出结果，只是「哪台机器」这一栏会空着。
/// 空着比编一个更诚实：编出来的连接名会让人去查一条不存在的连接。
pub fn assemble(
    queues: &[(String, u64, u64)],
    consumers: &[QueueConsumer],
    connections: &[ConnectionFacts],
    channels: &[ChannelFacts],
) -> OwnershipSnapshot {
    let by_connection: BTreeMap<&str, &ConnectionFacts> = connections
        .iter()
        .map(|item| (item.name.as_str(), item))
        .collect();
    let by_channel: BTreeMap<&str, &ChannelFacts> = channels
        .iter()
        .map(|item| (item.name.as_str(), item))
        .collect();

    // 同一个 (队列, tag, channel) 只算一条：`/api/queues` 与 `/api/consumers` 是两次独立请求，
    // 面板读到的可能是「刚被告知 consumer 已取消」的那份队列 + 取消之前的消费者列表。
    // 不去重的话，未确认数被加两次，健康判定也会因此误报「预取已满」。
    //
    // 这里必须带上 channel，不能只用 (队列, tag)：consumer tag 是**每个 channel**
    // 自动递增的（`amq.ctag-1`、`ctag-1`），不同服务、不同 channel 上出现同一个 tag
    // 是常态。只按 (队列, tag) 去重会把「两个服务各有一个消费者」压成一个，
    // 连接数与账号数跟着少算 —— 而这正是「谁在消费这个队列」要回答的那句话。
    // 真正的同一个消费者，channel 必然相同（见 `consumer_link::group_by_queue`）。
    let mut seen: BTreeSet<(String, String, Option<String>)> = BTreeSet::new();
    let mut owners: Vec<ConsumerOwner> = Vec::new();
    for consumer in consumers {
        if !seen.insert((
            consumer.queue.clone(),
            consumer.consumer_tag.clone(),
            consumer.channel.clone(),
        )) {
            continue;
        }
        let channel = consumer
            .channel
            .as_deref()
            .and_then(|name| by_channel.get(name).copied());
        // 连接名有三个来源，按「准到不准」取：channel 的父连接最准，
        // 消费者自带的 connection_name 次之（它其实是客户端上报的名字，不是服务端 id）。
        let connection_name = channel
            .map(|item| item.connection.clone())
            .filter(|name| !name.is_empty());
        let connection = connection_name
            .as_deref()
            .and_then(|name| by_connection.get(name).copied());

        let username = if consumer.username.is_empty() {
            channel.map(|item| item.user.clone()).unwrap_or_default()
        } else {
            consumer.username.clone()
        };

        owners.push(ConsumerOwner {
            queue: consumer.queue.clone(),
            consumer_tag: consumer.consumer_tag.clone(),
            connection: connection.map(|item| item.name.clone()),
            client_name: connection
                .map(|item| item.client_name.clone())
                .filter(|name| !name.is_empty())
                .or_else(|| consumer.connection_name.clone()),
            channel: consumer.channel.clone(),
            username,
            prefetch_count: consumer.prefetch_count,
            messages_unacknowledged: consumer.messages_unacknowledged,
            ack_required: consumer.ack_required,
            health: judge(consumer),
            peer: connection
                .map(|item| item.peer.clone())
                .filter(|peer| !peer.is_empty()),
            connection_blocked: connection.is_some_and(|item| item.blocked),
        });
    }

    // 队列侧要有「没人消费的队列」：那本身就是结论，不能因为查不到消费者就省略。
    let mut by_queue: BTreeMap<&str, Vec<&ConsumerOwner>> = BTreeMap::new();
    for owner in &owners {
        by_queue
            .entry(owner.queue.as_str())
            .or_default()
            .push(owner);
    }

    let mut result: Vec<QueueOwnership> = queues
        .iter()
        .map(|(name, ready, unacked)| {
            let mut items: Vec<ConsumerOwner> = by_queue
                .get(name.as_str())
                .map(|list| list.iter().map(|item| (*item).clone()).collect())
                .unwrap_or_default();
            items.sort_by(|left, right| {
                left.connection_label()
                    .cmp(right.connection_label())
                    .then_with(|| left.consumer_tag.cmp(&right.consumer_tag))
            });
            // 先算完再 move：`items` 下面要被搬进结构体。
            let connections = items
                .iter()
                .map(|item| item.connection_label().to_owned())
                .collect::<BTreeSet<String>>()
                .len();
            let users = items
                .iter()
                .filter(|item| !item.username.is_empty())
                .map(|item| item.username.clone())
                .collect::<BTreeSet<String>>()
                .len();
            let troubled = items.iter().filter(|item| item.is_unhealthy()).count();
            QueueOwnership {
                queue: name.clone(),
                messages_ready: *ready,
                messages_unacknowledged: *unacked,
                owners: items,
                connections,
                users,
                troubled,
            }
        })
        .collect();
    result.sort_by(|left, right| left.queue.cmp(&right.queue));

    // 按账号汇总：同一套凭证被几个服务共用来回是最难查的那种故障。
    let mut user_map: BTreeMap<&str, UserOwnership> = BTreeMap::new();
    for item in &result {
        for owner in &item.owners {
            if owner.username.is_empty() {
                // 读不到账号的消费者不进账号视图：编一个「未知账号」会让人
                // 以为集群里真有个叫这个名字的用户。
                continue;
            }
            let entry = user_map
                .entry(owner.username.as_str())
                .or_insert_with(|| UserOwnership {
                    username: owner.username.clone(),
                    connections: 0,
                    consumers: 0,
                    queues: Vec::new(),
                    messages_ready: 0,
                });
            entry.consumers += 1;
            if !entry.queues.contains(&item.queue) {
                entry.queues.push(item.queue.clone());
            }
        }
    }
    for entry in user_map.values_mut() {
        let queues: BTreeSet<&str> = result
            .iter()
            .filter(|item| {
                item.owners
                    .iter()
                    .any(|owner| owner.username == entry.username)
            })
            .map(|item| item.queue.as_str())
            .collect();
        entry.messages_ready = result
            .iter()
            .filter(|item| queues.contains(item.queue.as_str()))
            .map(|item| item.messages_ready)
            .sum();
        let connections: BTreeSet<&str> = result
            .iter()
            .flat_map(|item| item.owners.iter())
            .filter(|owner| owner.username == entry.username)
            .map(|owner| owner.connection_label())
            .collect();
        entry.connections = connections.len();
        entry.queues.sort();
    }
    let users: Vec<UserOwnership> = user_map.into_values().collect();

    let blocked_consumers = owners.iter().filter(|item| item.connection_blocked).count();

    let mut notes = Vec::new();
    if blocked_consumers > 0 {
        notes.push(
            "有消费者的连接已经不在运行（阻塞或正在关闭）：消费者还挂在列表上，消息却不会被投递"
                .to_owned(),
        );
    }
    let single = result
        .iter()
        .filter(|item| item.is_single_connection())
        .count();
    if single > 0 {
        notes.push(format!(
            "{single} 个队列只有一条连接在消费：横向扩容不会自动分摊，多起来的消费者会被 RabbitMQ 轮流投递而不是并行处理"
        ));
    }
    if owners.iter().any(|item| item.connection.is_none()) {
        notes.push(
            "部分消费者找不到所属连接：通常是没有管理 API 读连接的权限，或者连接刚断、消费者还没从列表里消失"
                .to_owned(),
        );
    }

    OwnershipSnapshot {
        queues: result,
        users,
        blocked_consumers,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consumer(queue: &str, tag: &str, channel: &str) -> QueueConsumer {
        QueueConsumer {
            queue: queue.to_owned(),
            consumer_tag: tag.to_owned(),
            connection_name: None,
            channel: Some(channel.to_owned()),
            username: String::new(),
            ack_required: true,
            prefetch_count: 1,
            messages_unacknowledged: 0,
        }
    }

    fn connection(name: &str, client: &str, peer: &str, blocked: bool) -> ConnectionFacts {
        ConnectionFacts {
            name: name.to_owned(),
            client_name: client.to_owned(),
            user: "app".to_owned(),
            peer: peer.to_owned(),
            blocked,
        }
    }

    fn channel(name: &str, connection: &str) -> ChannelFacts {
        ChannelFacts {
            name: name.to_owned(),
            connection: connection.to_owned(),
            user: "app".to_owned(),
        }
    }

    #[test]
    fn consumer_is_attached_to_its_connection_through_the_channel() {
        let snapshot = assemble(
            &[("orders".to_owned(), 10, 0)],
            &[consumer("orders", "t1", "ch-1")],
            &[connection("conn-1", "svc-a", "10.0.0.1:52312", false)],
            &[channel("ch-1", "conn-1")],
        );
        let owner = &snapshot.queues[0].owners[0];
        // 连接名走 channel 的父连接，不是消费者自带的 connection_name（那是客户端上报的名字）。
        assert_eq!(owner.connection.as_deref(), Some("conn-1"));
        assert_eq!(owner.client_name.as_deref(), Some("svc-a"));
        assert_eq!(owner.peer.as_deref(), Some("10.0.0.1:52312"));
        // 消费者自己没带账号时，从 channel 补。
        assert_eq!(owner.username, "app");
    }

    #[test]
    fn missing_connection_is_left_empty_not_invented() {
        // 没有读连接的权限是常态。编一个连接名会让人去查一条不存在的连接。
        let snapshot = assemble(
            &[("orders".to_owned(), 1, 0)],
            &[consumer("orders", "t1", "ch-9")],
            &[],
            &[],
        );
        let owner = &snapshot.queues[0].owners[0];
        assert!(owner.connection.is_none());
        assert_eq!(owner.connection_label(), "未知连接");
        assert!(
            snapshot
                .notes
                .iter()
                .any(|note| note.contains("找不到所属连接"))
        );
    }

    #[test]
    fn channels_of_one_connection_count_as_one_connection() {
        // 「有几个消费者」真正的答案是「几条连接」：一个服务 12 个 channel 还是 1 条连接。
        let snapshot = assemble(
            &[("orders".to_owned(), 10, 0)],
            &[
                consumer("orders", "t1", "ch-1"),
                consumer("orders", "t2", "ch-2"),
            ],
            &[connection("conn-1", "svc-a", "10.0.0.1:1", false)],
            &[channel("ch-1", "conn-1"), channel("ch-2", "conn-1")],
        );
        let queue = &snapshot.queues[0];
        assert_eq!(queue.owners.len(), 2);
        assert_eq!(queue.connections, 1);
        assert!(queue.is_single_connection());
        assert!(queue.verdict().contains("单连接独占"));
    }

    #[test]
    fn duplicate_consumer_rows_are_not_double_counted() {
        let snapshot = assemble(
            &[("orders".to_owned(), 10, 10)],
            &[
                consumer("orders", "t1", "ch-1"),
                consumer("orders", "t1", "ch-1"),
            ],
            &[],
            &[],
        );
        assert_eq!(snapshot.queues[0].owners.len(), 1);
    }

    #[test]
    fn same_tag_on_two_channels_counts_as_two_consumers() {
        // 回归：consumer tag 是每个 channel 自己递增的，两条连接上各有一个
        // `ctag-1` 很常见。只按 (队列, tag) 去重会把它压成一个消费者，
        // 「有几个消费者 / 几条连接」这个结论正是这张表要回答的那句话。
        let mut left = consumer("orders", "ctag-1", "ch-1");
        left.connection_name = Some("svc-a".to_owned());
        let mut right = consumer("orders", "ctag-1", "ch-2");
        right.connection_name = Some("svc-b".to_owned());

        let snapshot = assemble(
            &[("orders".to_owned(), 10, 0)],
            &[left, right],
            &[
                connection("conn-1", "svc-a", "10.0.0.1:1", false),
                connection("conn-2", "svc-b", "10.0.0.2:2", false),
            ],
            &[channel("ch-1", "conn-1"), channel("ch-2", "conn-2")],
        );

        let queue = &snapshot.queues[0];
        assert_eq!(queue.owners.len(), 2, "两条 channel 上是两个真实消费者");
        assert_eq!(queue.connections, 2);
        assert!(!queue.is_single_connection());
        assert_eq!(snapshot.users[0].consumers, 2);
    }

    #[test]
    fn queue_without_consumers_is_kept_and_reported() {
        let snapshot = assemble(&[("audit".to_owned(), 5, 0)], &[], &[], &[]);
        assert_eq!(snapshot.queues.len(), 1);
        assert!(snapshot.queues[0].is_unconsumed());
        assert!(snapshot.verdict().contains("没人消费"));
    }

    #[test]
    fn empty_queue_without_consumers_is_not_unconsumed() {
        let snapshot = assemble(&[("audit".to_owned(), 0, 0)], &[], &[], &[]);
        assert!(!snapshot.queues[0].is_unconsumed());
        assert!(snapshot.queues[0].verdict().contains("队列是空的"));
    }

    #[test]
    fn blocked_connection_is_flagged_on_every_consumer() {
        // 消费者还挂在列表上、连接却已经阻塞：这是「看起来有人在消费、消息却不动」最直接的解释。
        let snapshot = assemble(
            &[("orders".to_owned(), 10, 0)],
            &[consumer("orders", "t1", "ch-1")],
            &[connection("conn-1", "svc-a", "10.0.0.1:1", true)],
            &[channel("ch-1", "conn-1")],
        );
        assert!(snapshot.queues[0].owners[0].connection_blocked);
        assert!(snapshot.queues[0].owners[0].is_unhealthy());
        assert_eq!(snapshot.blocked_consumers, 1);
    }

    #[test]
    fn users_are_grouped_across_queues() {
        let snapshot = assemble(
            &[("orders".to_owned(), 4, 0), ("audit".to_owned(), 6, 0)],
            &[
                consumer("orders", "t1", "ch-1"),
                consumer("audit", "t2", "ch-1"),
            ],
            &[connection("conn-1", "svc-a", "10.0.0.1:1", false)],
            &[channel("ch-1", "conn-1")],
        );
        assert_eq!(snapshot.users.len(), 1);
        let user = &snapshot.users[0];
        assert_eq!(user.username, "app");
        assert_eq!(user.consumers, 2);
        assert_eq!(user.connections, 1);
        // 账号的堆积量按它消费的队列去重，两个队列不重复累加。
        assert_eq!(user.messages_ready, 10);
    }

    #[test]
    fn consumers_without_a_username_stay_out_of_the_user_view() {
        let mut item = consumer("orders", "t1", "ch-1");
        item.username = String::new();
        let snapshot = assemble(&[("orders".to_owned(), 1, 0)], &[item], &[], &[]);
        // 编一个「未知账号」会让人以为集群里真有个叫这个名字的用户。
        assert!(snapshot.users.is_empty());
    }

    #[test]
    fn prefetch_saturated_consumer_marks_the_queue() {
        let mut item = consumer("orders", "t1", "ch-1");
        item.prefetch_count = 5;
        item.messages_unacknowledged = 5;
        let snapshot = assemble(&[("orders".to_owned(), 9, 5)], &[item], &[], &[]);
        assert_eq!(snapshot.queues[0].troubled, 1);
        assert!(snapshot.queues[0].verdict().contains("有异常"));
    }
}
