// @ts-expect-error node 内置模块未随仓库提供类型声明
import assert from "node:assert/strict";
// @ts-expect-error node 内置模块未随仓库提供类型声明
import { test } from "node:test";

import {
  byteRateText,
  entityLabel,
  groupQuotas,
  iterationsText,
  mechanismLabel,
  missingMechanisms,
  partialUsers,
  quotaEmptyTitle,
  quotaKeyLabel,
  quotaValueText,
  quotaVerdict,
  scramReadable,
  scramVerdict,
  scramVerdictOf,
} from "./quota.ts";
import type { QuotaEntry, ScramSnapshot, ScramUser } from "../types/quota.ts";

function entry(overrides: Partial<QuotaEntry> = {}): QuotaEntry {
  return {
    kind: "default",
    key: "producer_byte_rate",
    value: 1048576,
    ...overrides,
  };
}

function user(overrides: Partial<ScramUser> = {}): ScramUser {
  return { user: "alice", credentials: [], ...overrides };
}

test("字节速率跟着单位走，不让人自己数零", () => {
  assert.equal(byteRateText(512), "512 B");
  assert.equal(byteRateText(1048576), "1.00 MB");
  assert.equal(byteRateText(1073741824), "1.00 GB");
});

test("负值与 NaN 不装成数字", () => {
  assert.equal(byteRateText(-1), "未知");
  assert.equal(byteRateText(Number.NaN), "未知");
});

test("百分比不会读成每秒", () => {
  // 统一加 /s 会把 request_percentage 读成「每秒 75%」。
  assert.equal(entry({ key: "request_percentage", value: 75 }).value === 75, true);
  assert.equal(quotaValueText(entry({ key: "request_percentage", value: 75 })), "75%");
  assert.equal(quotaValueText(entry()), "1.00 MB/s");
});

test("不认识的配额键原样显示", () => {
  assert.equal(quotaKeyLabel("producer_byte_rate"), "生产者速率");
  assert.equal(quotaKeyLabel("future.key"), "future.key");
});

test("缺一半的实体读得懂", () => {
  // 只有客户端、没有用户：这是「给这个客户端的所有用户兜底」，
  // 不是「一个叫空字符串的用户」。
  assert.equal(entityLabel(entry({ kind: "clientId", clientId: "ingest" })), "客户端 ingest · 全部用户");
  assert.equal(entityLabel(entry({ kind: "user", user: "alice" })), "alice · 全部客户端");
  assert.equal(entityLabel(entry({ user: "alice", clientId: "app" })), "alice / app");
  assert.equal(entityLabel(entry()), "集群默认");
});

test("分组按实体聚合，同实体多键不拆开", () => {
  const entries = [
    entry({ kind: "user", user: "alice", key: "producer_byte_rate", value: 1 }),
    entry({ kind: "user", user: "alice", key: "consumer_byte_rate", value: 2 }),
    entry({ kind: "default" }),
  ];
  const groups = groupQuotas(entries);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["alice · 全部客户端", "集群默认"],
  );
  assert.equal(groups[0].items.length, 2);
});

test("读不到不装成没有配额", () => {
  // 这条是本页最容易犯的错：一次权限问题被读成「集群干净得很」。
  const failed = quotaVerdict({ entries: [], error: "权限不足", notes: [] });
  assert.match(failed, /读不到/);
  assert.equal(quotaEmptyTitle({ entries: [], error: "权限不足", notes: [] }), "配额读不到");

  const empty = quotaVerdict({ entries: [], notes: [] });
  assert.match(empty, /没有任何配额/);
  assert.equal(quotaEmptyTitle({ entries: [], notes: [] }), "还没有配额");
});

test("有配额时说的是实体数量", () => {
  const verdict = quotaVerdict({
    entries: [entry({ kind: "user", user: "a" }), entry({ kind: "default" })],
    notes: [],
  });
  assert.equal(verdict, "2 个实体被单独限速");
});

test("缺机制要说出来，那是客户端连不上的直接原因", () => {
  const only256 = user({ credentials: [{ mechanism: "sha256", iterations: 4096 }] });
  assert.deepEqual(missingMechanisms(only256), ["sha512"]);
  assert.equal(scramVerdict(only256), "缺 SCRAM-SHA-512");
  assert.equal(mechanismLabel("sha256"), "SCRAM-SHA-256");
});

test("两种机制都有时不啰嗦", () => {
  const both = user({
    credentials: [
      { mechanism: "sha256", iterations: 4096 },
      { mechanism: "sha512", iterations: 8192 },
    ],
  });
  assert.deepEqual(missingMechanisms(both), []);
  assert.equal(scramVerdict(both), "两种机制都有");
});

test("读失败的用户不算「缺了一个」", () => {
  // 不知道 ≠ 缺了。把它算进 partial 会让人去补凭据，而问题在权限上。
  const broken = user({ user: "bob", credentials: [], error: "权限不足" });
  const snapshot: ScramSnapshot = {
    users: [user({ credentials: [{ mechanism: "sha256", iterations: 4096 }] }), broken],
    notes: [],
  };
  assert.equal(partialUsers(snapshot).length, 1);
  assert.equal(scramVerdict(broken), "读取失败");
});

test("老 broker 不支持要单独说，别读成零用户", () => {
  const snapshot: ScramSnapshot = {
    users: [],
    unsupported: "broker 版本低于 2.7.0",
    notes: [],
  };
  assert.match(scramVerdictOf(snapshot), /不支持/);
  assert.equal(scramReadable(snapshot), false);
  // 空表被读成「一个 SCRAM 用户都没有」会把排查方向带到配置上去。
  assert.doesNotMatch(scramVerdictOf({ users: [], notes: [] }), /不支持/);
});

test("迭代次数带上单位与千分位", () => {
  assert.equal(iterationsText(4096), "4,096 次");
  assert.equal(iterationsText(0), "迭代次数未知");
});

test("结论覆盖全体用户与部分用户的差别", () => {
  assert.match(scramVerdictOf({ users: [], notes: [] }), /没有任何用户/);
  const snapshot: ScramSnapshot = {
    users: [
      user({ credentials: [{ mechanism: "sha256", iterations: 4096 }] }),
      user({
        user: "bob",
        credentials: [
          { mechanism: "sha256", iterations: 4096 },
          { mechanism: "sha512", iterations: 4096 },
        ],
      }),
    ],
    notes: [],
  };
  assert.equal(scramVerdictOf(snapshot), "2 个用户，其中 1 个只配了一种机制");
});
