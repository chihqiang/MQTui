import { useState } from "react";

import { Badge, Button, SectionTitle, StaleNotice } from "@/components/ui";
import { useGroupBlock } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import {
  advice,
  headline,
  memberText,
  regressedText,
  stuckLabel,
  verdictTone,
} from "@/lib/group-block";
import { BLOCK_DEFAULT_WINDOW_MS, BLOCK_WINDOWS } from "@/types/group-block";

/**
 * 消费组队头阻塞：谁卡住了。
 *
 * 总滞后说「还有 12 万条」、成员说「4 个都活着」、分区说「3 个在动」——
 * 三个数字都正常，但消费速度是 0。原因是分区内严格顺序：一个分区被一条
 * 处理不完的消息顶住，挂在它上面的那个成员就再也不动了。
 *
 * 与滞后趋势分开两块，是因为它们回答两个问题：那边问「积压是在涨还是降」，
 * 这边问「谁卡住了」。混在一句话里就变成「有点问题」。
 */
export function GroupBlockSection({
  connectionId,
  group,
}: {
  connectionId: string;
  group: string;
}) {
  const [windowMs, setWindowMs] = useState(BLOCK_DEFAULT_WINDOW_MS);
  // `undefined` = 还没开始采：打开弹窗只是想看成员，不该被拖住十秒。
  const [running, setRunning] = useState<number | undefined>(undefined);
  const sample = useGroupBlock(connectionId, group, running);
  const report = sample.data;

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle
        extra={
          <span className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md bg-slate-100 p-0.5">
              {BLOCK_WINDOWS.map((option) => (
                <button
                  key={option.ms}
                  type="button"
                  onClick={() => setWindowMs(option.ms)}
                  className={
                    option.ms === windowMs
                      ? "rounded bg-white px-2 py-0.5 text-(length:--text-app-meta) text-slate-800 shadow-xs"
                      : "rounded px-2 py-0.5 text-(length:--text-app-meta) text-slate-500 hover:text-slate-700"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Button
              size="xs"
              variant="secondary"
              loading={sample.isFetching}
              onClick={() => setRunning(windowMs)}
              title="读两次该组的进度，找「有滞后却一动不动」的分区。这一步必然要等满所选窗口"
            >
              {sample.isFetching ? "采样中…" : report ? "重新采样" : "检查阻塞"}
            </Button>
          </span>
        }
      >
        队头阻塞
      </SectionTitle>

      {sample.error && report ? (
        <StaleNotice
          message={failureText("重新采样", errorMessage(sample.error), group)}
          onRetry={() => setRunning(windowMs)}
        >
          下面是上一次采样算出的结果
        </StaleNotice>
      ) : null}
      {sample.error && !report ? (
        <p className="text-(length:--text-app-body) text-rose-700">
          {failureText("检查阻塞", errorMessage(sample.error), group)}
        </p>
      ) : null}

      {report ? (
        <Report report={report} />
      ) : !sample.error ? (
        <p className="text-(length:--text-app-body) text-slate-600">
          点「检查阻塞」读两次进度，找有没有分区「有滞后却一动不动」。
          <span className="text-slate-500">
            {" "}
            要等满所选窗口；数值只代表那一段时间，不落盘。
          </span>
        </p>
      ) : null}
    </section>
  );
}

function Report({
  report,
}: {
  report: NonNullable<ReturnType<typeof useGroupBlock>["data"]>;
}) {
  const tip = advice(report);
  const rewind = regressedText(report);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-(length:--text-app-body)">
        <Badge tone={verdictTone(report)}>{headline(report)}</Badge>
      </div>
      <p className="text-(length:--text-app-body) text-slate-600">{report.detail}</p>

      {report.stuck.length ? (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {report.stuck.map((item) => (
            <li
              key={stuckLabel(item)}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-(length:--text-app-body)"
            >
              <span className="font-mono text-slate-800">{stuckLabel(item)}</span>
              <span className="text-slate-500">滞后 {formatNumber(item.lag)}</span>
              <span className="ml-auto text-(length:--text-app-meta) text-meta">
                成员 {memberText(item)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {tip ? <p className="text-(length:--text-app-meta) text-slate-500">{tip}</p> : null}
      {rewind ? (
        <p className="text-(length:--text-app-meta) text-amber-700">{rewind}</p>
      ) : null}
    </div>
  );
}
