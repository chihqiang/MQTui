/**
 * 批量处置里「没放回队列」的那批消息，怎么呈现与怎么重试。
 *
 * 这条路径原本只报一个计数：`stranded: 3`。三个数字能做的唯一一件事就是
 * 让人担心 —— 它们是用户**根本没选中**的消息，界面上却没有一个地方能处理。
 *
 * 现在给的是完整 ID 列表，界面因此能提供「重试这批放回」。但这里有两个
 * 容易做反、且做完不报错的地方，所以抽成纯函数钉住：
 *
 * 1. **重试只能放回，不能处置**。这批消息不是用户选中的那些，
 *    被投出去就是凭空多出来的副本。
 * 2. **只有真的卡住了才给按钮**。`stranded` 为空却亮着按钮、
 *    或者卡住了却因为某处判空写错而不给按钮，都是这类界面的老毛病。
 */

/** 结果里描述「卡住」的那部分，与后端 `BatchDisposalOutcome` 对齐。 */
export interface StrandedOutcome {
  stranded?: string[];
  retryable?: boolean;
}

/** 卡住的消息是否值得给一个「重试这批放回」的入口。 */
export function canRetryStranded(outcome: StrandedOutcome | undefined): boolean {
  if (!outcome) return false;
  const ids = outcome.stranded ?? [];
  // `retryable` 缺省时按「能重试」处理：后端老版本没有这个字段，
  // 而卡住的消息本来就有重试这条路。`false` 才是明确的「点不动」。
  return ids.length > 0 && outcome.retryable !== false;
}

/**
 * 重试请求的入参。
 *
 * `queue` 必须由调用方给：卡住的那批是「同一队列里顺带取出来的」，
 * 但队列名不能从用户当前选中的那几条推 —— 选中集此时已经被清空了。
 */
export interface StrandedRetryInput<Action extends string = string> {
  action: Action;
  stranded: string[];
  queue: string;
  exchange: string;
  routingKey: string;
}

/** 把结果里的 `stranded` 组装成重试请求；没有可重试的消息时返回 `null`。 */
export function strandedRetryRequest<Action extends string>(
  outcome: StrandedOutcome | undefined,
  rest: Omit<StrandedRetryInput<Action>, "stranded">,
): (StrandedRetryInput<Action> & { messageIds: string[] }) | null {
  if (!canRetryStranded(outcome)) return null;
  const ids = outcome?.stranded ?? [];
  const queue = rest.queue.trim();
  if (!queue) return null;
  return {
    ...rest,
    queue,
    stranded: ids,
    messageIds: [...ids],
  };
}

/**
 * 卡住的那批去重后还剩几条。
 *
 * 重复的 ID 会进两次重试请求，第二次必然找不到、报一条让人困惑的失败。
 */
export function uniqueStranded(outcome: StrandedOutcome | undefined): string[] {
  const ids = outcome?.stranded ?? [];
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}
