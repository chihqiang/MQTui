// @ts-expect-error node 内置模块未随仓库提供类型声明（与 refresh.test.mts 一致）
import assert from "node:assert/strict";
// @ts-expect-error 同上
import test from "node:test";

import type { QueueConsumer, QueueConsumption } from "../types/consumer-link.ts";
import {
  describeOverview,
  judgeConsumer,
  matchQueue,
  queueVerdict,
  summarizeQueues,
} from "./consumer-link.ts";

function consumer(overrides: Partial<QueueConsumer> = {}): QueueConsumer {
  return {
    queue: "orders",
    consumerTag: "amq.ctag-1",
    connectionName: "svc-a",
    username: "app",
    ackRequired: true,
    prefetchCount: 10,
    messagesUnacknowledged: 0,
    ...overrides,
  };
}

function consumption(overrides: Partial<QueueConsumption> = {}): QueueConsumption {
  return {
    queue: "orders",
    messagesReady: 0,
    messagesUnacknowledged: 0,
    consumers: [consumer()],
    unhealthy: 0,
    ...overrides,
  };
}

test("预取塞满判为异常，超过上限也算满", () => {
  assert.equal(judgeConsumer(consumer({ prefetchCount: 10, messagesUnacknowledged: 10 })), "prefetchSaturated");
  assert.equal(judgeConsumer(consumer({ prefetchCount: 10, messagesUnacknowledged: 11 })), "prefetchSaturated");
  assert.equal(judgeConsumer(consumer({ prefetchCount: 10, messagesUnacknowledged: 9 })), "healthy");
});

test("自动 ack 的消费者永远不算异常", () => {
  assert.equal(judgeConsumer(consumer({ ackRequired: false, prefetchCount: 5, messagesUnacknowledged: 99 })), "healthy");
});

test("无上限预取只在真有未确认消息时提示", () => {
  assert.equal(judgeConsumer(consumer({ prefetchCount: 0, messagesUnacknowledged: 1 })), "unboundedPrefetch");
  assert.equal(judgeConsumer(consumer({ prefetchCount: 0, messagesUnacknowledged: 0 })), "healthy");
});

test("有堆积没消费者才算 unconsumed", () => {
  assert.equal(queueVerdict(consumption({ consumers: [], messagesReady: 3 })), "unconsumed");
  assert.equal(queueVerdict(consumption({ consumers: [], messagesReady: 0 })), "healthy");
});

test("卡在预取上限优先于无上限预取报出", () => {
  const stalled = consumption({
    consumers: [
      consumer({ consumerTag: "a", prefetchCount: 0, messagesUnacknowledged: 5 }),
      consumer({ consumerTag: "b", prefetchCount: 2, messagesUnacknowledged: 2 }),
    ],
  });
  assert.equal(queueVerdict(stalled), "stalled");
});

test("汇总计数按队列去重", () => {
  const overview = summarizeQueues([
    consumption({ queue: "a", consumers: [], messagesReady: 5 }),
    consumption({ queue: "b", consumers: [], messagesReady: 0 }),
    consumption({
      queue: "c",
      messagesUnacknowledged: 1,
      consumers: [consumer({ prefetchCount: 1, messagesUnacknowledged: 1 })],
    }),
    consumption({
      queue: "d",
      messagesUnacknowledged: 2,
      consumers: [consumer({ prefetchCount: 0, messagesUnacknowledged: 2 })],
    }),
    consumption({ queue: "e", messagesUnacknowledged: 1 }),
  ]);
  // c 卡在预取上限、d 无上限预取，都不算「真在消费」；只有 e 计入活跃。
  assert.deepEqual(overview, { unconsumed: 1, stalled: 1, greedy: 1, activeQueues: 1 });
});

test("过滤命中队列名、连接名与消费者标签", () => {
  const item = consumption();
  assert.ok(matchQueue(item, "ORD"));
  assert.ok(matchQueue(item, "svc-a"));
  assert.ok(matchQueue(item, "ctag"));
  assert.ok(matchQueue(item, "  "));
  assert.ok(!matchQueue(item, "audit"));
});

test("结论文案在全部正常时明说，异常时逐项列出", () => {
  const healthy = describeOverview({ queues: [consumption()], unacknowledgedTotal: 0 });
  assert.match(healthy, /未发现异常/);

  const broken = describeOverview({
    queues: [
      consumption({ queue: "a", consumers: [], messagesReady: 1 }),
      consumption({
        queue: "b",
        consumers: [consumer({ prefetchCount: 1, messagesUnacknowledged: 1 })],
      }),
    ],
    unacknowledgedTotal: 1,
  });
  assert.match(broken, /无人消费/);
  assert.match(broken, /预取上限/);
});

test("没有队列时不说「状态正常」", () => {
  // 「未发现异常：0 个队列的消费端状态正常」自相矛盾，连错 vhost 时最容易看到。
  const text = describeOverview({ queues: [], unacknowledgedTotal: 0 });
  assert.ok(!text.includes("状态正常"), text);
  assert.ok(text.includes("没有队列"), text);
});
