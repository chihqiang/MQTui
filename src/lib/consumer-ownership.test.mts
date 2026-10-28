import { expect, test } from "vitest";

import {
  connectionLabel,
  isSingleConnection,
  isUnconsumed,
  isUnhealthy,
  matchQueue,
  onlyTroubled,
  ownershipVerdict,
  queueVerdict,
  singleConnectionQueues,
} from "./consumer-ownership.ts";
import type {
  ConsumerOwner,
  OwnershipSnapshot,
  QueueOwnership,
} from "../types/consumer-ownership.ts";

function owner(overrides: Partial<ConsumerOwner> = {}): ConsumerOwner {
  return {
    queue: "orders",
    consumerTag: "amq.ctag-1",
    connection: "conn-1",
    clientName: "svc-a",
    channel: "ch-1",
    username: "app",
    prefetchCount: 10,
    messagesUnacknowledged: 0,
    ackRequired: true,
    health: "healthy",
    peer: "10.0.0.1:52312",
    connectionBlocked: false,
    ...overrides,
  };
}

function queue(overrides: Partial<QueueOwnership> = {}): QueueOwnership {
  const owners = overrides.owners ?? [owner()];
  return {
    queue: "orders",
    messagesReady: 10,
    messagesUnacknowledged: 0,
    owners,
    connections: new Set(owners.map(connectionLabel)).size,
    users: new Set(owners.map((item) => item.username)).size,
    troubled: owners.filter(isUnhealthy).length,
    ...overrides,
  };
}

function snapshot(queues: QueueOwnership[], users: OwnershipSnapshot["users"] = []): OwnershipSnapshot {
  return {
    queues,
    users,
    blockedConsumers: queues
      .flatMap((item) => item.owners)
      .filter((item) => item.connectionBlocked).length,
    notes: [],
  };
}

test("连接名优先客户端上报的那个", () => {
  expect(connectionLabel(owner())).toBe("svc-a");
  // 服务端生成的名字没有信息量，但比「未知」好。
  expect(connectionLabel(owner({ clientName: undefined }))).toBe("conn-1");
  expect(connectionLabel(owner({ clientName: undefined, connection: undefined }))).toBe("未知连接");
});

test("连接阻塞要算进异常，即使消费者本身健康", () => {
  // 「看起来有消费者、消息却不动」最直接的解释就是连接已经阻塞。
  const blocked = owner({ connectionBlocked: true });
  expect(isUnhealthy(blocked)).toBe(true);
  expect(isUnhealthy(owner())).toBe(false);
  expect(isUnhealthy(owner({ health: "prefetchSaturated" }))).toBe(true);
});

test("有堆积零消费者才算「无人消费」", () => {
  expect(isUnconsumed(queue({ owners: [], connections: 0, users: 0, messagesReady: 5 }))).toBe(true);
  // 空队列没人消费不该报警 —— 那不是故障，是常态。
  expect(isUnconsumed(queue({ owners: [], connections: 0, users: 0, messagesReady: 0 }))).toBe(false);
});

test("一个服务开多个 channel 仍然是一条连接", () => {
  const item = queue({
    owners: [
      owner({ consumerTag: "t1", channel: "ch-1" }),
      owner({ consumerTag: "t2", channel: "ch-2" }),
    ],
  });
  expect(item.connections).toBe(1);
  expect(isSingleConnection(item)).toBe(true);
  expect(queueVerdict(item)).toContain("单连接独占");
});

test("两个账号各开一条连接时不算独占", () => {
  const item = queue({
    owners: [
      owner({ clientName: "svc-a" }),
      owner({ consumerTag: "t2", clientName: "svc-b", username: "other" }),
    ],
  });
  expect(item.connections).toBe(2);
  expect(isSingleConnection(item)).toBe(false);
  expect(queueVerdict(item)).not.toContain("独占");
});

test("队列结论区分「没人消费」与「没人消费但队列是空的」", () => {
  expect(queueVerdict(queue({ owners: [], connections: 0, users: 0, messagesReady: 7 }))).toContain(
    "堆着 7 条",
  );
  expect(queueVerdict(queue({ owners: [], connections: 0, users: 0, messagesReady: 0 }))).toContain(
    "队列是空的",
  );
});

test("一个消费者都没有时说清有几个队列在等", () => {
  // 「没有任何消费者」听起来像集群是空的，得补一句「几个队列堆着」。
  const one = snapshot([queue({ owners: [], connections: 0, users: 0, messagesReady: 3 })]);
  expect(ownershipVerdict(one)).toContain("1 个队列堆着消息");
  const idle = snapshot([queue({ owners: [], connections: 0, users: 0, messagesReady: 0 })]);
  expect(ownershipVerdict(idle)).toBe("没有任何消费者");
});

test("快照结论同时报消费者、连接、账号三个数", () => {
  const text = ownershipVerdict(
    snapshot([queue()], [{ username: "app", connections: 1, consumers: 1, queues: ["orders"], messagesReady: 10 }]),
  );
  expect(text).toBe("1 个消费者 / 1 条连接 / 1 个账号");
});

test("连接阻塞时快照结论单独点出来", () => {
  const text = ownershipVerdict(snapshot([queue({ owners: [owner({ connectionBlocked: true })] })]));
  expect(text).toContain("连接已阻塞");
});

test("搜对端地址能找到队列", () => {
  // 排查「哪个 pod 在消费」时，能搜的往往只有一个 IP。
  expect(matchQueue(queue(), "10.0.0.1")).toBe(true);
  expect(matchQueue(queue(), "svc-a")).toBe(true);
  expect(matchQueue(queue(), "app")).toBe(true);
  expect(matchQueue(queue(), "orders")).toBe(true);
  expect(matchQueue(queue(), "nope")).toBe(false);
});

test("空关键词不过滤", () => {
  expect(matchQueue(queue(), "   ")).toBe(true);
});

test("只看有问题的队列：无人消费 / 有异常 / 连接阻塞", () => {
  const healthy = queue();
  const starving = queue({ queue: "audit", owners: [], connections: 0, users: 0, messagesReady: 9 });
  const saturated = queue({
    queue: "pay",
    owners: [owner({ health: "prefetchSaturated", messagesUnacknowledged: 10 })],
  });
  expect(onlyTroubled([healthy, starving, saturated]).map((item) => item.queue)).toEqual([
    "audit",
    "pay",
  ]);
});

test("单连接独占的队列能被单独挑出来", () => {
  const exclusive = queue();
  const shared = queue({
    queue: "pay",
    owners: [owner(), owner({ consumerTag: "t2", clientName: "svc-b" })],
  });
  expect(singleConnectionQueues(snapshot([exclusive, shared])).map((item) => item.queue)).toEqual([
    "orders",
  ]);
});
