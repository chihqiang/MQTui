import { expect, test } from "vitest";

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
  expect(byteRateText(512)).toBe("512 B");
  expect(byteRateText(1048576)).toBe("1.00 MB");
  expect(byteRateText(1073741824)).toBe("1.00 GB");
});

test("负值与 NaN 不装成数字", () => {
  expect(byteRateText(-1)).toBe("未知");
  expect(byteRateText(Number.NaN)).toBe("未知");
});

test("百分比不会读成每秒", () => {
  // 统一加 /s 会把 request_percentage 读成「每秒 75%」。
  expect(entry({ key: "request_percentage", value: 75 }).value === 75).toBe(true);
  expect(quotaValueText(entry({ key: "request_percentage", value: 75 }))).toBe("75%");
  expect(quotaValueText(entry())).toBe("1.00 MB/s");
});

test("不认识的配额键原样显示", () => {
  expect(quotaKeyLabel("producer_byte_rate")).toBe("生产者速率");
  expect(quotaKeyLabel("future.key")).toBe("future.key");
});

test("缺一半的实体读得懂", () => {
  // 只有客户端、没有用户：这是「给这个客户端的所有用户兜底」，
  // 不是「一个叫空字符串的用户」。
  expect(entityLabel(entry({ kind: "clientId", clientId: "ingest" }))).toBe("客户端 ingest · 全部用户");
  expect(entityLabel(entry({ kind: "user", user: "alice" }))).toBe("alice · 全部客户端");
  expect(entityLabel(entry({ user: "alice", clientId: "app" }))).toBe("alice / app");
  expect(entityLabel(entry())).toBe("集群默认");
});

test("分组按实体聚合，同实体多键不拆开", () => {
  const entries = [
    entry({ kind: "user", user: "alice", key: "producer_byte_rate", value: 1 }),
    entry({ kind: "user", user: "alice", key: "consumer_byte_rate", value: 2 }),
    entry({ kind: "default" }),
  ];
  const groups = groupQuotas(entries);
  expect(groups.length).toBe(2);
  expect(groups.map((group) => group.label)).toEqual(["alice · 全部客户端", "集群默认"]);
  expect(groups[0].items.length).toBe(2);
});

test("读不到不装成没有配额", () => {
  // 这条是本页最容易犯的错：一次权限问题被读成「集群干净得很」。
  const failed = quotaVerdict({ entries: [], error: "权限不足", notes: [] });
  expect(failed).toMatch(/读不到/);
  expect(quotaEmptyTitle({ entries: [], error: "权限不足", notes: [] })).toBe("配额读不到");

  const empty = quotaVerdict({ entries: [], notes: [] });
  expect(empty).toMatch(/没有任何配额/);
  expect(quotaEmptyTitle({ entries: [], notes: [] })).toBe("还没有配额");
});

test("有配额时说的是实体数量", () => {
  const verdict = quotaVerdict({
    entries: [entry({ kind: "user", user: "a" }), entry({ kind: "default" })],
    notes: [],
  });
  expect(verdict).toBe("2 个实体被单独限速");
});

test("缺机制要说出来，那是客户端连不上的直接原因", () => {
  const only256 = user({ credentials: [{ mechanism: "sha256", iterations: 4096 }] });
  expect(missingMechanisms(only256)).toEqual(["sha512"]);
  expect(scramVerdict(only256)).toBe("缺 SCRAM-SHA-512");
  expect(mechanismLabel("sha256")).toBe("SCRAM-SHA-256");
});

test("两种机制都有时不啰嗦", () => {
  const both = user({
    credentials: [
      { mechanism: "sha256", iterations: 4096 },
      { mechanism: "sha512", iterations: 8192 },
    ],
  });
  expect(missingMechanisms(both)).toEqual([]);
  expect(scramVerdict(both)).toBe("两种机制都有");
});

test("读失败的用户不算「缺了一个」", () => {
  // 不知道 ≠ 缺了。把它算进 partial 会让人去补凭据，而问题在权限上。
  const broken = user({ user: "bob", credentials: [], error: "权限不足" });
  const snapshot: ScramSnapshot = {
    users: [user({ credentials: [{ mechanism: "sha256", iterations: 4096 }] }), broken],
    notes: [],
  };
  expect(partialUsers(snapshot).length).toBe(1);
  expect(scramVerdict(broken)).toBe("读取失败");
});

test("老 broker 不支持要单独说，别读成零用户", () => {
  const snapshot: ScramSnapshot = {
    users: [],
    unsupported: "broker 版本低于 2.7.0",
    notes: [],
  };
  expect(scramVerdictOf(snapshot)).toMatch(/不支持/);
  expect(scramReadable(snapshot)).toBe(false);
  // 空表被读成「一个 SCRAM 用户都没有」会把排查方向带到配置上去。
  expect(scramVerdictOf({ users: [], notes: [] })).not.toMatch(/不支持/);
});

test("迭代次数带上单位与千分位", () => {
  expect(iterationsText(4096)).toBe("4,096 次");
  expect(iterationsText(0)).toBe("迭代次数未知");
});

test("结论覆盖全体用户与部分用户的差别", () => {
  expect(scramVerdictOf({ users: [], notes: [] })).toMatch(/没有任何用户/);
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
  expect(scramVerdictOf(snapshot)).toBe("2 个用户，其中 1 个只配了一种机制");
});
