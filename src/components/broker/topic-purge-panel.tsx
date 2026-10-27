import { useState } from "react";

import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Input,
  Select,
} from "@/components/ui";
import { usePreviewPurge, usePurgeTopic } from "@/hooks/use-topics";
import { formatNumber } from "@/lib/format";
import {
  buildRequest,
  canSubmit,
  checkBoundary,
  confirmNotes,
  parseBoundary,
  removedText,
  scopeText,
} from "@/lib/purge";
import {
  PURGE_KIND_OPTIONS,
  type PurgeKind,
  type PurgePlan,
  type TopicDetail,
} from "@/types";

/**
 * 主题写操作：清空、按时间删记录。
 *
 * 在此之前，清掉一个主题里的脏数据只能回终端敲 `kafka-topics.sh` ——
 * 而用户刚刚是在面板上看见这堆脏数据的。这一块只补这一个断点。
 *
 * 三处刻意的克制：
 * - **不提供「按分区勾选」的默认值**：默认全部分区，但选中范围会显式写在
 *   确认框里。部分清空是最常见的误操作，所以范围必须念出来。
 * - **确认要手打主题名**：删除不可逆，点两下和想一想是两件不同的事。
 * - **删完不自动刷新整页**：分区水位会变、可读起点会变，重取一次就够，
 *   刷新整页会让人以为进了另一个主题。
 */
export function TopicPurgePanel({
  connectionId,
  detail,
}: {
  connectionId: string | undefined;
  detail: TopicDetail;
}) {
  const [kind, setKind] = useState<PurgeKind>("truncate");
  const [boundary, setBoundary] = useState("");
  const [plan, setPlan] = useState<PurgePlan | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const preview = usePreviewPurge(connectionId);
  const purge = usePurgeTopic(connectionId);

  const hint = PURGE_KIND_OPTIONS.find((option) => option.value === kind)?.hint ?? "";
  const before = parseBoundary(boundary);
  // 填了时间就先在本地拦一道：秒级时间戳会把整个主题清空，
  // 这个错不该等一次网络往返才被指出来。
  const localError =
    kind === "deleteBefore" ? checkBoundary(before, Date.now()) : undefined;

  const onPreview = () => {
    const request = buildRequest(detail.name, kind, before, []);
    preview.mutate(request, { onSuccess: setPlan });
  };

  const onCommit = () => {
    const request = buildRequest(detail.name, kind, before, []);
    purge.mutate(request, {
      onSuccess: () => {
        setConfirming(false);
        setPlan(undefined);
      },
    });
  };

  return (
    <Card>
      <CardHeader
        title="清空与删除"
        extra={
          <span className="text-(length:--text-app-meta) text-slate-500">
            只动可读起点，磁盘等 retention 回收
          </span>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {detail.internal ? (
          <Callout tone="warning">
            {detail.name} 是 Kafka 内部主题：消费组位点与事务状态都在里面，这里不提供写操作。
          </Callout>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-(length:--text-app-meta) text-slate-500">操作</span>
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as PurgeKind);
                // 换了操作，旧的计划就没有意义了 —— 留着它会让人以为那是新计划。
                setPlan(undefined);
              }}
            >
              {PURGE_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>

          {kind === "deleteBefore" ? (
            <label className="flex flex-col gap-1">
              <span className="text-(length:--text-app-meta) text-slate-500">截止时间</span>
              <Input
                type="datetime-local"
                value={boundary}
                onChange={(event) => {
                  setBoundary(event.target.value);
                  setPlan(undefined);
                }}
              />
            </label>
          ) : null}

          <Button
            variant="secondary"
            loading={preview.isPending}
            disabled={Boolean(localError) || detail.internal}
            onClick={onPreview}
          >
            预览影响
          </Button>
        </div>

        <p className="text-(length:--text-app-meta) text-slate-500">{hint}</p>
        {localError && kind === "deleteBefore" ? (
          <p className="text-(length:--text-app-body) text-amber-700">{localError}</p>
        ) : null}

        {plan ? <PlanPreview plan={plan} /> : null}

        {canSubmit(plan) ? (
          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              执行删除
            </Button>
          </div>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={confirming}
        danger
        title={`删除 ${detail.name} 的消息`}
        confirmLabel="确认删除"
        loading={purge.isPending}
        requirePhrase={detail.name}
        description={
          plan ? (
            <div className="flex flex-col gap-2">
              <span>
                {removedText(plan)} · {scopeText(plan)}
              </span>
              <ul className="flex flex-col gap-1">
                {confirmNotes(plan).map((note) => (
                  <li key={note} className="flex gap-1.5">
                    <span aria-hidden>·</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
              <span className="text-secondary">请手打主题名以确认。</span>
            </div>
          ) : null
        }
        onConfirm={onCommit}
        onClose={() => setConfirming(false)}
      />
    </Card>
  );
}

function PlanPreview({ plan }: { plan: PurgePlan }) {
  if (plan.blocked) {
    return <Callout tone="warning">{plan.blocked}</Callout>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-(length:--text-app-body)">
        <Badge tone={plan.removed > 0 ? "danger" : "neutral"}>{removedText(plan)}</Badge>
        <span className="text-slate-500">{scopeText(plan)}</span>
      </div>

      <div className="max-h-52 overflow-auto rounded border border-slate-200">
        <table className="w-full text-left text-(length:--text-app-body)">
          <thead className="text-(length:--text-app-meta) text-secondary">
            <tr className="border-b border-slate-200">
              <th className="px-2 py-1.5 font-normal">分区</th>
              <th className="px-2 py-1.5 font-normal">当前起点</th>
              <th className="px-2 py-1.5 font-normal">推到</th>
              <th className="px-2 py-1.5 font-normal">删除条数</th>
            </tr>
          </thead>
          <tbody>
            {plan.partitions.map((item) => (
              <tr key={item.partition} className="border-b border-slate-200 last:border-0">
                <td className="px-2 py-1.5 font-mono text-slate-800">P{item.partition}</td>
                <td className="px-2 py-1.5 text-slate-500">{formatNumber(item.currentLow)}</td>
                <td className="px-2 py-1.5 text-slate-700">{formatNumber(item.targetLow)}</td>
                <td className="px-2 py-1.5 text-slate-700">
                  {formatNumber(Math.max(0, item.targetLow - item.currentLow))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {plan.notes.map((note) => (
        <p key={note} className="text-(length:--text-app-meta) text-slate-500">
          {note}
        </p>
      ))}
    </div>
  );
}
