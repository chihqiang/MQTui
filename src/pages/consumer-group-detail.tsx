import { Badge, ErrorState, Loading, Modal } from "@/components/ui";
import { useConsumerGroup } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { formatLag, groupState, lagTone } from "@/lib/consumer";
import { formatNumber } from "@/lib/format";
import type { ConsumerGroupInfo } from "@/types";

interface Props {
  connectionId: string;
  group: ConsumerGroupInfo;
  onClose: () => void;
}

/**
 * 消费组详情：成员列表 + 各分区滞后。
 *
 * 列表页只有组级信息，滞后量在这里按需计算 —— 打开时才去查水位，
 * 避免几百个组一次性把集群问一遍。
 */
export function ConsumerGroupDialog({ connectionId, group, onClose }: Props) {
  const { data, isLoading, error, refetch } = useConsumerGroup(
    connectionId,
    group.name,
  );
  const state = groupState(data?.group.state ?? group.state);

  return (
    <Modal open title={`消费组 · ${group.name}`} onClose={onClose}>
      {isLoading ? (
        <Loading label="读取消费组详情…" />
      ) : error ? (
        <ErrorState
          message={errorMessage(error)}
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <Badge tone={state.tone}>{state.label}</Badge>
            <span>成员 {formatNumber(data.group.members)}</span>
            <span>
              总滞后{" "}
              <Badge tone={lagTone(data.group.totalLag)}>
                {formatLag(data.group.totalLag)}
              </Badge>
            </span>
          </div>

          <section>
            <h4 className="mb-1.5 text-xs uppercase tracking-wide text-slate-500">
              成员
            </h4>
            {data.members.length ? (
              <ul className="divide-y divide-slate-800 rounded border border-slate-800">
                {data.members.map((member, index) => (
                  <li
                    key={member.memberId ?? `member-${index}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs"
                  >
                    <span className="font-mono text-slate-200">
                      {member.clientId ?? "-"}
                    </span>
                    <span className="text-slate-500">
                      {member.clientHost ?? "-"}
                    </span>
                    <span className="ml-auto truncate font-mono text-[11px] text-slate-600">
                      {member.memberId ?? "-"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">
                当前没有在线成员（组为空或消费者已下线）
              </p>
            )}
          </section>

          <section>
            <h4 className="mb-1.5 text-xs uppercase tracking-wide text-slate-500">
              分区进度（共 {formatNumber(data.offsets.length)} 个）
            </h4>
            {data.offsets.length ? (
              <div className="max-h-72 overflow-auto rounded border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-900 text-[11px] uppercase tracking-wide text-slate-500">
                    <tr className="border-b border-slate-800">
                      <th className="px-3 py-1.5 font-normal">topic</th>
                      <th className="px-3 py-1.5 font-normal">分区</th>
                      <th className="px-3 py-1.5 font-normal">已提交</th>
                      <th className="px-3 py-1.5 font-normal">末尾</th>
                      <th className="px-3 py-1.5 font-normal">滞后</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.offsets.map((offset) => (
                      <tr
                        key={`${offset.topic}-${offset.partition}`}
                        className="border-b border-slate-800/60 last:border-0"
                      >
                        <td className="px-3 py-1.5 font-mono text-slate-300">
                          {offset.topic}
                        </td>
                        <td className="px-3 py-1.5 text-slate-400">
                          P{offset.partition}
                        </td>
                        <td className="px-3 py-1.5 text-slate-400">
                          {formatNumber(offset.offset)}
                        </td>
                        <td className="px-3 py-1.5 text-slate-400">
                          {formatNumber(offset.high)}
                        </td>
                        <td className="px-3 py-1.5">
                          <Badge tone={lagTone(offset.lag)}>
                            {formatLag(offset.lag)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-500">该组尚未提交任何位点</p>
            )}
          </section>
        </div>
      ) : null}
    </Modal>
  );
}
