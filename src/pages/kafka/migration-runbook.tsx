import { useState } from "react";

import { Badge, Button, Input, Textarea } from "@/components/ui";
import { useMigrationRunbook, useParseMigrationVerify } from "@/hooks/use-topics";
import type {
  MigrationRunbook,
  PreconditionState,
  VerifyResult,
  VerifyState,
} from "@/types/reassignment";
import { VERIFY_LABEL } from "@/types/reassignment";
import type { Tone } from "@/types/tone";

const STATE_TONE: Record<PreconditionState, Tone> = {
  ok: "success",
  warn: "warning",
  block: "danger",
  unknown: "info",
};

const VERIFY_TONE: Record<VerifyState, Tone> = {
  completed: "success",
  inProgress: "warning",
  failed: "danger",
  unknown: "info",
};

/**
 * 迁移执行方案。
 *
 * 这一块回答的是「接下来在命令行里到底要敲什么、敲之前该确认什么」。
 * 面板自己不发起迁移 —— 当前 rdkafka 绑定里没有 `AlterPartitionReassignments`，
 * 拼一个半残的裸 FFI 去调，写错一个 broker id 就是把数据搬到不存在的节点。
 *
 * 但「不能自己执行」不等于「只能丢一句去跑命令行」：脚本参数、前置条件、
 * `--verify` 输出的解读，这三件最容易出错的活都搬到这里做。
 */
export function MigrationRunbookView({
  connectionId,
  topic,
  plan,
  disabled,
}: {
  connectionId: string | undefined;
  topic: string;
  plan: string;
  disabled?: boolean;
}) {
  const [throttle, setThrottle] = useState("");
  const [planFile, setPlanFile] = useState("reassignment.json");
  const [minInsync, setMinInsync] = useState("");
  const [runbook, setRunbook] = useState<MigrationRunbook | null>(null);
  const [output, setOutput] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  const build = useMigrationRunbook(connectionId);
  const parse = useParseMigrationVerify(connectionId);

  const onBuild = () => {
    setVerify(null);
    build.mutate(
      {
        topic,
        plan,
        throttle: toNumber(throttle),
        planFile: planFile.trim() || undefined,
        minInsync: toNumber(minInsync),
      },
      { onSuccess: setRunbook },
    );
  };

  const onVerify = () => {
    parse.mutate({ topic, plan, output }, { onSuccess: setVerify });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="限流（字节/秒）" hint="建议 52428800 = 50MB/s">
          <Input
            className="w-32 text-xs"
            value={throttle}
            onChange={(event) => setThrottle(event.currentTarget.value)}
            placeholder="不限流"
            inputMode="numeric"
          />
        </Field>
        <Field label="计划文件名" hint="命令行那侧的路径">
          <Input
            className="w-44 text-xs"
            value={planFile}
            onChange={(event) => setPlanFile(event.currentTarget.value)}
            placeholder="reassignment.json"
          />
        </Field>
        <Field label="min.insync.replicas" hint="不填则按读不到处理">
          <Input
            className="w-28 text-xs"
            value={minInsync}
            onChange={(event) => setMinInsync(event.currentTarget.value)}
            placeholder="未知"
            inputMode="numeric"
          />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || build.isPending || !plan.trim()}
          onClick={onBuild}
        >
          {build.isPending ? "生成中…" : "生成执行方案"}
        </Button>
      </div>

      {runbook ? <RunbookBody runbook={runbook} /> : null}

      <div className="flex flex-col gap-2 border-t border-slate-200 pt-3">
        <div className="flex items-center gap-2">
          <span className="text-(length:--text-app-meta) uppercase tracking-wide text-slate-500">
            粘贴 --verify 输出
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || parse.isPending || !output.trim() || !plan.trim()}
            onClick={onVerify}
          >
            {parse.isPending ? "解析中…" : "解析并核对"}
          </Button>
        </div>
        <Textarea
          value={output}
          onChange={(event) => {
            setOutput(event.currentTarget.value);
            // 输出改了，旧结论立刻作废。
            setVerify(null);
          }}
          rows={4}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={"Reassignment of partition orders-0 is completed\nReassignment of partition orders-1 is still in progress"}
          aria-label="verify 输出"
        />
        {verify ? <VerifyBody result={verify} /> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-(length:--text-app-meta) text-slate-500" title={hint}>
        {label}
      </span>
      {children}
    </label>
  );
}

function RunbookBody({ runbook }: { runbook: MigrationRunbook }) {
  const blocking = runbook.preconditions.filter((item) => item.state === "block");

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-slate-200">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs">
          <Badge tone={runbook.actionable ? "success" : "danger"}>
            {runbook.actionable ? "可以开始" : "先处理上面的阻断项"}
          </Badge>
          <span className="text-slate-500">
            {runbook.preconditions.length} 项前置检查 · {blocking.length} 项阻断
          </span>
        </div>
        <ul className="flex flex-col divide-y divide-slate-200/60 text-xs">
          {runbook.preconditions.map((item) => (
            <li key={item.key} className="flex items-start gap-2 px-3 py-2">
              <Badge tone={STATE_TONE[item.state]}>{labelOf(item.state)}</Badge>
              <div className="min-w-0">
                <p className="text-slate-800">{item.title}</p>
                <p className="text-slate-500">{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <ScriptBlock title="① 生成计划（导出当前布局后再改）" script={runbook.generateScript} />
      <ScriptBlock title="② 执行迁移" script={runbook.executeScript} muted={!runbook.actionable} />
      <ScriptBlock title="③ 核对进度（可反复执行）" script={runbook.verifyScript} />

      <div className="rounded-md border border-slate-200 px-3 py-2 text-xs">
        <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-slate-500">执行完记得做</p>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-slate-500">
          {runbook.followups.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ScriptBlock({
  title,
  script,
  muted,
}: {
  title: string;
  script: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5">
        <span className="text-(length:--text-app-meta) uppercase tracking-wide text-slate-500">{title}</span>
        <button
          type="button"
          className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-(length:--text-app-meta) text-slate-600 hover:bg-slate-100"
          onClick={() => void navigator.clipboard?.writeText(script)}
        >
          复制
        </button>
      </div>
      <pre
        className={
          muted
            ? "overflow-auto px-3 py-2 font-mono text-(length:--text-app-meta) text-slate-400"
            : "overflow-auto px-3 py-2 font-mono text-(length:--text-app-meta) text-slate-600"
        }
      >
        {script}
      </pre>
    </div>
  );
}

function VerifyBody({ result }: { result: VerifyResult }) {
  const { summary, notes } = result;

  return (
    <div className="rounded-md border border-slate-200">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs">
        <Badge tone={summary.failed ? "danger" : summary.inProgress ? "warning" : "success"}>
          {summary.verdict}
        </Badge>
        <span className="text-slate-500">
          完成 {summary.completed} · 进行中 {summary.inProgress} · 失败 {summary.failed}
        </span>
      </div>
      {notes.length ? (
        <ul className="flex flex-col gap-1 border-b border-slate-200 px-3 py-2 text-xs text-amber-700">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      <div className="max-h-48 overflow-auto">
        <table className="w-full text-left text-xs">
          <tbody>
            {summary.lines.map((line) => (
              <tr key={line.raw} className="border-b border-slate-200 last:border-0">
                <td className="w-40 px-3 py-1.5 font-mono text-slate-600">{line.partition}</td>
                <td className="w-24 px-3 py-1.5">
                  <Badge tone={VERIFY_TONE[line.state]}>{VERIFY_LABEL[line.state]}</Badge>
                </td>
                <td className="px-3 py-1.5 text-slate-500">{line.raw}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.lines.some((line) => line.state === "unknown") ? (
        <p className="border-t border-slate-200 px-3 py-2 text-(length:--text-app-meta) text-slate-500">
          有 {summary.lines.filter((line) => line.state === "unknown").length} 行认不出来，
          已按原文列在上面。命令行改过文案时会这样，不会当成成功。
        </p>
      ) : null}
    </div>
  );
}

/** 空串与非法输入都按「没填」处理：多一个默认值就多一次猜。 */
function toNumber(raw: string): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function labelOf(state: PreconditionState): string {
  switch (state) {
    case "ok":
      return "通过";
    case "warn":
      return "注意";
    case "block":
      return "阻断";
    default:
      return "未知";
  }
}
