/**
 * 连接首页的几个纯逻辑：历史行怎么拼、这份配置要不要口令、徽标底色。
 *
 * 它们原来长在页面文件里，而「要不要口令」这条判断在向导里也有一份 ——
 * 两处口径不同时，表单显示「不需要口令」，连接却弹认证失败。
 */

import { mergeHistory, type ConnectionHistoryItem } from "./connection-history.ts";
import { defaultConnection, endpointOf, withEndpoint } from "./connection-defaults.ts";
import { listRecentConnections, readDraft, type SavedConnection } from "./session-storage.ts";
import { BROKER_TONE_CLASS, brokerTone } from "./visual.ts";
import type { BrokerKind, ConnectionConfig } from "../types/broker.ts";

/** 徽标底色。未知类型退回中性灰，不拿品牌色冒充。 */
export function toneClass(tone: ReturnType<typeof brokerTone>): string {
  return tone === "neutral" ? "bg-slate-100 text-secondary" : BROKER_TONE_CLASS[tone].tint;
}

/**
 * 一条历史 + 现场补的账号口令 → 一份能提交的配置。
 *
 * 底子是表单草稿（上次填过的 TLS、SASL 机制、vhost 都还在里面）；没有草稿就从默认值起。
 * 只覆盖三处：地址（历史说了算，那是真连过的那台）、用户名与口令。草稿只是「这台机器上
 * 同一份表单的记忆」，就地重试不写回它 —— 不留记录这件事得是真的。
 */
export function configForHistory(
  item: ConnectionHistoryItem,
  credential: { username: string; password: string },
): ConnectionConfig {
  const kind = item.kind as BrokerKind;
  const base = withEndpoint(readDraft(kind) ?? defaultConnection(kind), item.endpoint);
  if (base.kind === "kafka") {
    return {
      ...base,
      auth: { ...base.auth, username: credential.username, password: credential.password },
    };
  }
  return {
    ...base,
    auth: {
      ...base.auth,
      username: credential.username || base.auth.username,
      password: credential.password,
    },
  };
}

/**
 * 这份配置要不要口令。
 *
 * Kafka 看 SASL 机制（`none` 就是明文直连）；RabbitMQ 看有没有填账号 ——
 * 默认的 `guest` 也算「要」，它是真的会被校验的。
 */
export function needsAuth(config: ConnectionConfig): boolean {
  if (config.kind === "kafka") return config.auth.mechanism !== "none";
  return config.auth.username.trim() !== "" || config.auth.password !== "";
}

/** 首页的历史 = 保存过的记录 + 连成功过的地址（只有名字与地址，没有口令）。 */
export function historyOf(savedList: readonly SavedConnection[]) {
  return mergeHistory(
    savedList.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.config.kind,
      endpoint: endpointOf(entry.config),
      savedAt: entry.savedAt,
      hasSecret: Boolean(entry.config.auth.password),
      noAuth: !needsAuth(entry.config),
    })),
    listRecentConnections(),
  );
}


