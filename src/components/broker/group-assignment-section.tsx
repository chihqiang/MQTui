import { Badge, SectionTitle, StaleNotice } from "@/components/ui";
import { useConsumerGroupAssignment } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import {
  assignmentVerdict,
  memberAssignmentText,
  memberAssignmentTone,
  unownedPartitions,
  unownedText,
} from "@/lib/group-assignment";
import { formatNumber } from "@/lib/format";
import type { ConsumerGroupOffset } from "@/types";

/**
 * 成员分区归属：滞后压在谁身上。
 *
 * 上面两张表各自都对、合起来却是空的：「4 个成员都活着」+「P3 落后 12 万」
 * 回答不了「那 P3 是谁在读」。这一块就补那一列。
 *
 * 三种「没有分区」分开说 —— 读不懂、暂未分到、协议不适用。
 * 合并成一句「暂无」会把「我不知道」讲成「一切正常」。
 */
export function GroupAssignmentSection({
  connectionId,
  group,
  offsets,
}: {
  connectionId: string;
  group: string;
  /** 组当前的分区进度：用来判断哪些分区没人负责。 */
  offsets: ConsumerGroupOffset[];
}) {
  const { data, error, isFetching, refetch } = useConsumerGroupAssignment(
    connectionId,
    group,
  );
  const verdict = assignmentVerdict(data, offsets);
  const unowned = unownedPartitions(data, offsets);
  // 结论已经把那句话说过一遍的，不再重复列出来。
  const readableNotes = (data?.notes ?? []).filter(
    (note) => note !== verdict?.text,
  );

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>成员归属</SectionTitle>

      {error && data ? (
        <StaleNotice
          message={failureText("刷新成员归属", errorMessage(error), group)}
          onRetry={() => void refetch()}
        >
          下面是上一次读取的归属
        </StaleNotice>
      ) : null}
      {error && !data ? (
        <p className="text-(length:--text-app-body) text-rose-700">
          {failureText("读取成员归属", errorMessage(error), group)}
        </p>
      ) : null}

      {verdict ? (
        <div className="flex flex-wrap items-center gap-3 text-(length:--text-app-body)">
          <Badge tone={verdict.tone}>{verdict.text}</Badge>
          {isFetching ? (
            <span className="text-(length:--text-app-meta) text-meta">
              刷新中…
            </span>
          ) : null}
        </div>
      ) : null}

      {unowned.length ? (
        <p className="text-(length:--text-app-meta) text-amber-700">
          没有成员负责：{unownedText(unowned)}
        </p>
      ) : null}

      {/* 后端已经说过的话不重复说第二遍：协议不适用时结论本身就是那条说明，
          再列一遍只会像两条不同的警报。 */}
      {readableNotes.length ? (
        <ul className="flex flex-col gap-1">
          {readableNotes.map((note) => (
            <li
              key={note}
              className="text-(length:--text-app-meta) text-slate-500"
            >
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      {data?.byMember.length ? (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {data.byMember.map((entry) => (
            <li
              key={entry.memberId}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 text-(length:--text-app-body)"
            >
              <span className="font-mono text-slate-800">{entry.memberId}</span>
              <span className="ml-auto text-right text-(length:--text-app-meta) text-slate-600">
                {entry.state === "assigned" ? (
                  <span className="mr-2 text-meta">
                    {formatNumber(entry.partitions.length)} 个分区
                  </span>
                ) : null}
                <Badge tone={memberAssignmentTone(entry)}>
                  {memberAssignmentText(entry)}
                </Badge>
              </span>
              {entry.problem ? (
                <span className="w-full text-(length:--text-app-meta) text-amber-700">
                  {entry.problem}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {data && !data.byMember.length && !(data.notes ?? []).length ? (
        <p className="text-(length:--text-app-body) text-slate-500">
          组里没有在线成员，因此没有分区归属
        </p>
      ) : null}
    </section>
  );
}
