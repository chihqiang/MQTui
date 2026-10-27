import { useState } from "react";

import { Badge, Button, Card, CardBody, CardHeader, Textarea } from "@/components/ui";
import {
  useCheckReassignmentPlan,
  useExportReassignmentPlan,
  useMigrationProgress,
} from "@/hooks/use-topics";
import { formatNumber } from "@/lib/format";
import { MigrationRunbookView } from "@/pages/kafka/migration-runbook";
import { MIGRATION_LABEL, type MigrationReport, type PlanCheck } from "@/types";
import type { Tone } from "@/types/tone";

const STATE_TONE: Record<keyof typeof MIGRATION_LABEL, Tone> = {
  done: "success",
  syncing: "warning",
  pending: "warning",
  unknown: "danger",
};

/**
 * 分区迁移：计划校验 + 进度跟踪。
 *
 * 这一层不做「一键执行」。分区重分配一旦发起就由集群后台任务接管，
 * 面板无法回滚；写错一个 broker id，数据会被搬到一个不存在的节点上。
 * 所以这里给的是**看清楚**：计划对不对、搬到哪一步了、哪些分区还没到位。
 *
 * 执行请用命令行：`kafka-reassign-partitions.sh --execute --reassignment-json-file <文件>`。
 */
export function MigrationPanel({
  connectionId,
  topic,
  disabled,
  disabledReason,
}: {
  connectionId: string | undefined;
  topic: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [plan, setPlan] = useState("");
  const [check, setCheck] = useState<PlanCheck | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);

  const exportPlan = useExportReassignmentPlan(connectionId);
  const checkPlan = useCheckReassignmentPlan(connectionId);
  const progress = useMigrationProgress(connectionId);

  const pending = exportPlan.isPending || checkPlan.isPending || progress.isPending;

  const onExport = () => {
    setCheck(null);
    setReport(null);
    exportPlan.mutate(topic, { onSuccess: setPlan });
  };

  const onCheck = () => {
    setReport(null);
    checkPlan.mutate({ topic, plan }, { onSuccess: setCheck });
  };

  const onProgress = () => {
    progress.mutate({ topic, plan }, { onSuccess: setReport });
  };

  return (
    <Card>
      <CardHeader
        title="分区迁移"
        extra={
          <span className="text-(length:--text-app-meta) text-slate-500">
            只做计划校验与进度跟踪，执行请用命令行
          </span>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {disabled ? (
          <p className="text-(length:--text-app-body) text-amber-700">{disabledReason ?? "该主题不支持分区迁移"}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={disabled || pending} onClick={onExport}>
            导出当前布局
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || pending || !plan.trim()}
            onClick={onCheck}
          >
            校验计划
          </Button>
          <Button
            size="sm"
            disabled={disabled || pending || !plan.trim()}
            onClick={onProgress}
          >
            检查进度
          </Button>
          {plan ? (
            <span className="text-(length:--text-app-meta) text-slate-500">
              计划 {formatNumber(plan.split("\n").length)} 行
            </span>
          ) : null}
        </div>

        <Textarea
          value={plan}
          onChange={(event) => {
            setPlan(event.currentTarget.value);
            // 计划改了，旧结论立刻作废——留着它就是让人对着过期的判断做决定。
            setCheck(null);
            setReport(null);
          }}
          rows={8}
          spellCheck={false}
          className="font-mono text-(length:--text-app-body)"
          placeholder={
            '{"version":1,"partitions":[{"topic":"orders","partition":0,"replicas":[1,2]}]}'
          }
          aria-label="重分配计划"
        />

        {check ? (
          <div className="rounded-md border border-slate-200 px-3 py-2 text-(length:--text-app-body)">
            {check.ok ? (
              <p className="text-emerald-700">
                计划可用：{check.plan?.partitions.length ?? 0} 个分区
              </p>
            ) : (
              <p className="text-rose-700">{check.reason}</p>
            )}
            <p className="mt-1 text-slate-500">
              集群 broker：{check.brokers.length ? check.brokers.join(", ") : "（读不到节点列表）"}
              {check.topicExists ? "" : " · 主题不存在"}
            </p>
          </div>
        ) : null}

        {report ? <ProgressTable report={report} /> : null}

        <MigrationRunbookView
          connectionId={connectionId}
          topic={topic}
          plan={plan}
          disabled={disabled}
        />
      </CardBody>
    </Card>
  );
}

/** 进度表：只列还没到位的分区之外，也把已完成的收进去——「搬完了几个」是同一个问题的另一半。 */
function ProgressTable({ report }: { report: MigrationReport }) {
  return (
    <div className="rounded-md border border-slate-200">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-(length:--text-app-body)">
        <Badge tone={report.running || report.unknown ? "warning" : "success"}>
          {report.running || report.unknown ? "迁移未完成" : "迁移完成"}
        </Badge>
        <span className="text-slate-500">
          已完成 {report.done} · 待迁移 {report.running} · 计划外 {report.unknown}
        </span>
        <span className="text-slate-500">{report.verdict}</span>
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left text-(length:--text-app-body)">
          <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">
            <tr className="border-b border-slate-200">
              <th className="px-3 py-1.5 font-normal">分区</th>
              <th className="px-3 py-1.5 font-normal">状态</th>
              <th className="px-3 py-1.5 font-normal">目标副本</th>
              <th className="px-3 py-1.5 font-normal">当前副本</th>
              <th className="px-3 py-1.5 font-normal">待补齐</th>
              <th className="px-3 py-1.5 font-normal">待移除</th>
            </tr>
          </thead>
          <tbody>
            {report.partitions.map((item) => (
              <tr key={item.partition} className="border-b border-slate-200 last:border-0">
                <td className="px-3 py-1.5 font-mono text-slate-600">{item.partition}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={STATE_TONE[item.state]}>{MIGRATION_LABEL[item.state]}</Badge>
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-500">
                  {item.target.join(", ") || "-"}
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-500">
                  {item.current.join(", ") || "-"}
                </td>
                <td className="px-3 py-1.5 font-mono text-amber-700">
                  {item.missing.join(", ") || "-"}
                </td>
                <td className="px-3 py-1.5 font-mono text-rose-700">
                  {item.extra.join(", ") || "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
