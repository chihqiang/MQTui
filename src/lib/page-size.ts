/**
 * 消息列表单页条数：取值 → 真正发给后端的条数。
 *
 * 这个数曾经是 `use-messages.ts` 里写死的 100，后来又变成设置里的一个开关。
 * 开关撤掉之后回到「一个默认值 + 一层夹紧」：默认 100 条是读起来不卡、
 * 翻页也不至于太勤的那个数，不该让用户去猜。
 *
 * 两件事容易做反且不报错：
 *
 * 1. **越界不夹紧**：后端 `clamp_limit` 收在 1..=500。传 0 会被它悄悄改成 1
 *    （一次一条，翻页翻到天荒地老）；传 5000 会被砍到 500，可前端以为自己拿到
 *    5000 条。两边的「实际值」必须是同一个。
 * 2. **脏数据不兜底**：`pageSize` 可能来自老版本、手改过的 localStorage，
 *    `NaN` 传进请求体是 `null`，后端按默认值处理 —— 于是一页 100 条，
 *    而界面显示的是用户设的那个数。
 */

/** 与后端 `DEFAULT_MESSAGE_LIMIT` 对齐。 */
export const DEFAULT_PAGE_SIZE = 100;

/** 与后端 `MAX_MESSAGE_LIMIT` 对齐。 */
export const MAX_PAGE_SIZE = 500;

/** 是否可用于发请求：正整数才认。 */
export function isPageSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 把候选值转成实际请求条数。
 *
 * `undefined` / 非整数 / 非正数 → 默认值；超过上限 → 上限。
 * 返回的永远是后端会原样接受的那个数。
 */
export function resolvePageSize(value: unknown): number {
  if (!isPageSize(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}
