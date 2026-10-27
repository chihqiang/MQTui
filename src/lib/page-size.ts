/**
 * 消息列表单页条数：偏好值 → 真正发给后端的条数。
 *
 * 这个数以前是 `use-messages.ts` 里写死的 100，而偏好里那个 `pageSize`
 * 全库没人读过 —— 设置里能调、调完没反应，比没有那个开关更糟。
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

/** 设置里能选的值。别的一律夹紧，不做「特殊照顾」。 */
export const PAGE_SIZE_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 50, label: "50", hint: "一页 50 条，翻页最勤" },
  { value: 100, label: "100", hint: "默认：一页 100 条" },
  { value: 200, label: "200", hint: "一页 200 条，少翻几页" },
  { value: 500, label: "500", hint: "一页 500 条（后端上限），重但少翻" },
];

/** 偏好里的值是否可用于发请求：正整数才认。 */
export function isPageSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * 把偏好值转成实际请求条数。
 *
 * `undefined` / 非整数 / 非正数 → 默认值；超过上限 → 上限。
 * 返回的永远是后端会原样接受的那个数。
 */
export function resolvePageSize(value: unknown): number {
  if (!isPageSize(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}
