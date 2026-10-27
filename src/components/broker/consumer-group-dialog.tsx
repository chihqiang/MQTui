import { useNavigate } from "react-router";

import {
  Badge,
  Button,
  DataTable,
  ErrorState,
  Loading,
  Modal,
  SectionTitle,
  StaleNotice,
  TableCell,
  TableRow,
} from "@/components/ui";
import { useConsumerGroup } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatLag, groupState, lagTone } from "@/lib/consumer";
import { formatNumber } from "@/lib/format";
import { connectionPath } from "@/lib/nav";
import { OFFSET_COLUMNS } from "@/types/consumer";
import type { ConsumerGroupInfo } from "@/types";

import { GroupBlockSection } from "./group-block-section";
import { GroupDeleteButton } from "./group-delete-button";
import { LagTrendSection } from "./lag-trend-section";

/** 消费组详情弹窗的入口参数。 */
export interface ConsumerGroupDialogProps {
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
export function ConsumerGroupDialog({ connectionId, group, onClose }: ConsumerGroupDialogProps) {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useConsumerGroup(
    connectionId,
    group.name,
  );
  const state = groupState(data?.group.state ?? group.state);

  return (
    <Modal
      open
      title={`消费组 · ${group.name}`}
      onClose={onClose}
      // 删除放在页脚而不是标题旁：它是一次性的收尾动作，
      // 与上面那些「看」的内容不该抢视线。
      footer={<GroupDeleteButton connectionId={connectionId} group={group.name} onDeleted={onClose} />}
    >
      {/* 滞后量是这一页的全部价值，刷新失败时留着上一次算出来的数字，
          比换成一个红叉有用：至少还知道三分钟前落后多少。 */}
      {error && data ? (
        <StaleNotice
          message={failureText("刷新消费组", errorMessage(error), group.name)}
          onRetry={() => void refetch()}
        >
          滞后量是上一次读取的结果
        </StaleNotice>
      ) : null}
      {isLoading && !data ? <Loading label="读取消费组详情…" /> : null}
      {error && !data ? (
        <ErrorState
          message={failureText("读取消费组", errorMessage(error), group.name)}
          onRetry={() => void refetch()}
        />
      ) : null}
      {data ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-(length:--text-app-body) text-slate-500">
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
            <SectionTitle extra={data.members.length ? `共 ${formatNumber(data.members.length)} 个` : undefined}>
              成员
            </SectionTitle>
            {data.members.length ? (
              <ul className="divide-y divide-slate-200 rounded border border-slate-200">
                {data.members.map((member, index) => (
                  <li
                    key={member.memberId ?? `member-${index}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-(length:--text-app-body)"
                  >
                    <span className="font-mono text-slate-800">
                      {member.clientId ?? "-"}
                    </span>
                    <span className="text-slate-500">
                      {member.clientHost ?? "-"}
                    </span>
                    <span className="ml-auto truncate font-mono text-(length:--text-app-meta) text-meta">
                      {member.memberId ?? "-"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-(length:--text-app-body) text-slate-500">
                当前没有在线成员（组为空或消费者已下线）
              </p>
            )}
          </section>

          {/* 趋势放在分区进度之后：先看「现在卡在哪」，再问「是在追还是越欠越多」。
              顺序反了的话，用户会先读一分钟的趋势图再回头看明细。 */}
          <LagTrendSection connectionId={connectionId} group={group.name} />

          <GroupBlockSection connectionId={connectionId} group={group.name} />

          <section>
            <SectionTitle
              extra={
                <span className="flex items-center gap-2">
                  <span>共 {formatNumber(data.offsets.length)} 个分区</span>
                  {/* 滞后是在这一页看见的，所以重置的入口也放在这一页：
                      让用户记住组名再跑到「位点重置」页重敲一遍，等于把刚看到的东西丢掉。
                      只带上组名，主题仍由用户在那一页选 —— 一个组往往横跨多个 topic。 */}
                  {data.offsets.length ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        navigate(
                          `${connectionPath(connectionId as string, "offsetReset")}?group=${encodeURIComponent(group.name)}`,
                        )
                      }
                      title="带着这个组名去位点重置页"
                    >
                      重置位点
                    </Button>
                  ) : null}
                </span>
              }
            >
              分区进度
            </SectionTitle>
            {data.offsets.length ? (
              <div className="max-h-72 overflow-auto rounded border border-slate-200">
                <DataTable columns={OFFSET_COLUMNS} className="text-(length:--text-app-body)">
                  {data.offsets.map((offset) => (
                    <TableRow key={`${offset.topic}-${offset.partition}`}>
                      <TableCell mono className="text-slate-600">
                        {offset.topic}
                      </TableCell>
                      <TableCell muted numeric>
                        P{offset.partition}
                      </TableCell>
                      <TableCell muted numeric>
                        {formatNumber(offset.offset)}
                      </TableCell>
                      <TableCell muted numeric>
                        {formatNumber(offset.high)}
                      </TableCell>
                      <TableCell align="right">
                        <Badge tone={lagTone(offset.lag)}>{formatLag(offset.lag)}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </DataTable>
              </div>
            ) : (
              <p className="text-(length:--text-app-body) text-slate-500">该组尚未提交任何位点</p>
            )}
          </section>
        </div>
      ) : null}
    </Modal>
  );
}
