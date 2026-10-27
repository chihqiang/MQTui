import { useMutation } from "@tanstack/react-query";

import { messageService } from "@/services";
import type { MessageLocate } from "@/types";

export {
  appendPage,
  bucketHits,
  describeScanProgress,
  type LocatePage,
  type TimeBucket,
} from "@/lib/locate-result";

/** 一次定位最多返回多少条，与后端给普通列表的上限一致。 */
export const LOCATE_LIMIT = 200;

/**
 * 按 key / 时间区间定位消息，并支持沿游标续扫。
 *
 * 不用 `useQuery`：续扫是「在上一次结果之上继续」，每次请求都带着上一次的游标，
 * 缓存 key 会随游标变化而无限增长，反而让「同条件不重扫」这条规则失效。
 * 这里用 mutation 显式驱动：点「定位」= 从头扫，点「继续」= 带游标续扫。
 *
 * 也不用 `useInfiniteQuery`：它假设 `pageParam` 由自己维护，而游标是后端给的，
 * 且「条件变了游标作废」这类规则必须由调用方（表单）掌握。
 */
export function useMessageLocate() {
  return useMutation({
    mutationFn: (request: MessageLocate) => messageService.locateMessages(request),
  });
}
