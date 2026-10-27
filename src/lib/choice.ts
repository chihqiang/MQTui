/**
 * 「候选下拉」的纯逻辑。
 *
 * 一件事想清楚了再写样式：**哪些格子该给候选，不是看它长得像不像选择，而是看它的取值集合
 * 是不是这台机器上已经存在的名字**。topic、队列、交换机、vhost、消费组都是后者 ——
 * 名字由人填一次，之后两年都在被复制粘贴，让下一个人凭记忆敲出来没有任何好处。
 *
 * 反过来，正则是模式（`^orders\.`）、payload 是自由内容、优先级是数字：它们没有「已存在的集合」，
 * 硬做下拉只会变成一排误导人的快捷值。判断标准写在这个文件里，页面只管往上传候选。
 */

/** 一个候选。`hint` 用来放分组（`主题` / `最近`）或状态（`Stable · 3 成员`）。 */
export interface Choice {
  value: string;
  hint?: string;
}

/** 候选清单：允许重复传同一个名字（比如「最近」与「全部」两段），由 `dedupeChoices` 收口。 */
export type ChoiceList = readonly (Choice | string)[];

/** 最多渲染多少条。列表再长也只是滚动，不用虚拟化 —— 候选超过这个数，人就该打字了。 */
export const CHOICE_LIMIT = 50;

function toChoice(item: Choice | string): Choice {
  return typeof item === "string" ? { value: item } : item;
}

/**
 * 收口：去空、去重、限量。
 *
 * 保持传入顺序 —— 排序是调用方的事，把「最近的排前面」这种意图搬进组件，
 * 组件就得知道什么叫「最近」。同名取第一条带 `hint` 的：后来的重复项往往是完整列表，
 * 它没有分组信息，却会把前面那条标着「最近」的抹掉。
 */
export function dedupeChoices(items: ChoiceList, limit = CHOICE_LIMIT): Choice[] {
  const seen = new Map<string, Choice>();
  for (const item of items) {
    const choice = toChoice(item);
    const value = choice.value.trim();
    if (!value) continue;
    const existing = seen.get(value);
    if (!existing) {
      seen.set(value, { value, hint: choice.hint });
    } else if (!existing.hint && choice.hint) {
      seen.set(value, { value, hint: choice.hint });
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * 按输入过滤候选。
 *
 * 不区分大小写、按子串匹配：`order` 要能命中 `orders.created`。前缀匹配更「准」，
 * 但这一排候选的用途是「我记不全这个名字」，而人记得住的往往是中间那段。
 *
 * 当前值已经在候选里时**不把它挪到最前**：那会让回车选中的永远是自己，
 * 用户想选第二条时列表却在跳。
 */
export function filterChoices(items: readonly Choice[], query: string): Choice[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return [...items];
  return items.filter((item) => item.value.toLowerCase().includes(keyword));
}

/**
 * ↑ / ↓ 在候选里挪一格。
 *
 * 单独抽出来是因为 `-1` 与 `length` 的取模最容易写错，而错了的表现是「按上键跳到最后一条」
 * —— 不报错，只是用起来别扭。`current` 不在范围内时从边界重新开始。
 */
export function stepChoice(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0 || index >= length) return delta > 0 ? 0 : length - 1;
  return (index + delta + length) % length;
}

/**
 * 从拓扑里收出「确切的候选集合」。
 *
 * 返回值分两层：`null` 表示**没读到**（查询失败、或者这台 broker 不支持），
 * 空数组表示**读到了，但确实是空的**。这两件事在界面上必须分开处理：
 * 前者要放开手输，后者才敢说「只能从这里选」。把失败当成空列表，
 * 会让救火的人在拓扑接口抽风时连一个能填的框都没有。
 */
export function exactChoices(names: readonly string[] | undefined): string[] | null {
  if (!names) return null;
  return dedupeChoices(names).map((item) => item.value);
}

/** routing key 的候选：同一个源交换机上已经配过的那些；`source` 为空表示不限来源。 */
export function routingKeyChoices(
  bindings: readonly { source: string; routingKey: string }[] | undefined,
  source?: string,
): string[] | null {
  if (!bindings) return null;
  const picked = bindings.filter((item) => item.routingKey && (!source || item.source === source));
  return dedupeChoices(picked.map((item) => item.routingKey)).map((item) => item.value);
}
