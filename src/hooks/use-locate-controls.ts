import type { Dispatch, SetStateAction } from "react";
import type { UseMutationResult } from "@tanstack/react-query";

import { LOCATE_LIMIT, appendPage, type LocatePage } from "@/hooks/use-message-locate";
import { formatNumber } from "@/lib/format";
import {
  buildLocateRequest,
  completeContentRange,
  shiftContentRange,
  type ContentStep,
  type LocateForm,
} from "@/lib/message-locate";
import type { MessageLocate, MessageLocateResult } from "@/types";

/**
 * 定位面板上的四个动作：开扫、挪区间、续扫、以及「带游标重发一次」。
 *
 * 它们都得同时改三份状态（表单、已提交、已下发）并且发请求，混在渲染里写会变成
 * 四段互相抄的 `setX` 序列 —— 少改一处，界面上就会出现「区间写了新的、结果还是旧的」。
 * 收到这里，页面只剩「哪个按钮调哪个动作」。
 */
export function useLocateControls({
  connectionId,
  target,
  locate,
  page,
  applied,
  submitted,
  setForm,
  setSubmitted,
  setApplied,
  setPage,
  setNotice,
}: {
  connectionId: string;
  target: string;
  /** `useMessageLocate()` 的返回值：只需要 mutate。 */
  locate: Pick<UseMutationResult<MessageLocateResult, Error, MessageLocate>, "mutate">;
  page: LocatePage | undefined;
  applied: LocateForm;
  submitted: LocateForm;
  setForm: Dispatch<SetStateAction<LocateForm>>;
  setSubmitted: Dispatch<SetStateAction<LocateForm>>;
  setApplied: Dispatch<SetStateAction<LocateForm>>;
  setPage: Dispatch<SetStateAction<LocatePage | undefined>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
}) {
  /** 同条件续扫：把游标原样带上，不重读已看过的部分。 */
  const requestFor = (cursor?: string): MessageLocate | null => {
    const request = buildLocateRequest(connectionId, target, submitted, LOCATE_LIMIT);
    return request ? { ...request, cursor } : null;
  };

  const start = (override?: LocateForm) => {
    const source = override ?? submitted;
    const request = buildLocateRequest(connectionId, target, source, LOCATE_LIMIT);
    if (!request) return;
    const effective = completeContentRange(source);
    setNotice(null);
    setPage(undefined);
    setApplied(effective);
    if (override) setForm(effective);
    locate.mutate(request, { onSuccess: (result) => setPage(appendPage(undefined, result)) });
  };

  /** 把当前区间整体挪一步并立刻重扫：挪完区间，旧结果就不再对应新条件了。 */
  const shift = (step: ContentStep) => {
    const base = applied.after || applied.before ? applied : submitted;
    const next = shiftContentRange(base, step);
    if (next.after === applied.after && next.before === applied.before) return;
    setForm(next);
    setSubmitted(next);
    start(next);
  };

  const resume = () => {
    const request = requestFor(page?.cursor);
    if (!request) return;
    const scannedBefore = page?.totalScanned ?? 0;
    setNotice(null);
    locate.mutate(request, {
      onSuccess: (result) => {
        const next = appendPage(page, result);
        setPage(next);
        // 续扫没带来任何新命中时要说出来：否则按了「继续」页面毫无变化，
        // 用户无法判断是没读到、还是按钮坏了。
        if (result.items.length === 0) {
          setNotice(`续扫了 ${formatNumber(next.totalScanned - scannedBefore)} 条，没有新的命中`);
        }
      },
    });
  };

  return { requestFor, start, shift, resume };
}

