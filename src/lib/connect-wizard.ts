/**
 * 新建连接向导的纯逻辑：初始形态、地址摘要、键盘焦点。
 *
 * 这些函数都不碰 React，所以可以直接在 vitest 里验 ——
 * 「从历史进来时该带什么」「按 ↓ 该高亮哪张卡」这类规则，用眼睛看是看不出来的。
 */

import { defaultConnection, endpointOf, withEndpoint } from "./connection-defaults.ts";
import { readDraft, type SavedConnection } from "./session-storage.ts";
import type { BrokerKind, ConnectionConfig } from "../types/broker.ts";
import type { ConnectBuilder } from "../types/connection.ts";

/** 报错摘要里指认「刚才连的是哪儿」的那一段地址（`lib` 的 `endpointOf` 只认配置）。 */
export function endpointLabel(draft: ConnectBuilder, saved: SavedConnection | null): string | undefined {
  const source = draft.saved ?? saved;
  return source ? endpointOf(source.config) : (draft.endpoint ?? undefined);
}

/**
 * 「只记得地址」→ 一份可提交的配置初值。
 *
 * 拿草稿（没有就用默认值）当底，只替换地址那一格：历史里没存口令，
 * 别的字段也都没存过 —— 编造出来的值会让用户以为那是他上次填的。
 */
export function baseWithEndpoint(kind: BrokerKind, endpoint: string): ConnectionConfig {
  const draft = readDraft(kind);
  return withEndpoint(draft?.kind === kind ? draft : defaultConnection(kind), endpoint);
}

export function savedToConnectBuilder(saved: SavedConnection): ConnectBuilder {
  return { kind: saved.config.kind, saved, name: saved.name };
}

/**
 * 弹窗打开时的形态。
 *
 * 编辑记录优先（要带原名原配置）；其次看入口给没给类型 —— 首页卡片、新建行的
 * 按钮都给了，那是对「连哪种」已经作出的回答，直接进表单；顶栏「＋」什么都不给，
 * 才从第一步问起。
 */
export function initialDraft(saved: SavedConnection | null | undefined, kind: BrokerKind | null | undefined): ConnectBuilder {
  if (saved) return savedToConnectBuilder(saved);
  return { kind: kind ?? null, name: "" };
}

/** 焦点是否落在向导自己的元素里；`null` 的 target（比如 window）算不在。 */
export function containsWizard(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-wizard-keys]") !== null;
}

/** 第一步可选的那几张卡片，按视觉顺序。 */
export function kindList(root: ParentNode | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>("[data-wizard-keys] [role=option]"));
}

/** 把焦点交给卡片容器本身（不是某张卡）：`↓` 才能从第一张开始。 */
export function focusKindList(root: ParentNode | null): void {
  const scroller = root?.querySelector<HTMLElement>("[data-wizard-keys]");
  scroller?.focus();
}

/** 没填名字时的默认名：端点已经单列在记录行第二行，名字里不再重复地址。 */
export function defaultName(config: ConnectionConfig): string {
  return config.kind === "kafka" ? "Kafka" : "RabbitMQ";
}
