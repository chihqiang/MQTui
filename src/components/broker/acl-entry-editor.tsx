import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { Badge, Button, Callout, Field, Input, Modal, Select } from "@/components/ui";
import { useAclWrite } from "@/hooks/use-acl-write";
import {
  canSubmit,
  changeTone,
  confirmTarget,
  entryPrincipalCount,
  planVerdict,
  reportVerdict,
  ACL_CHANGE_LABEL,
  ACL_OPERATION_OPTIONS,
  ACL_PERMISSION_OPTIONS,
  ACL_RESOURCE_TYPES,
} from "@/lib/acl";
import { errorMessage } from "@/lib/errors";
import {
  ACL_OPERATION_LABEL,
  ACL_PERMISSION_LABEL,
  ACL_RESOURCE_LABEL,
} from "@/types/acl";
import type { AclChangePlan, AclEntry, AclWriteReport } from "@/types/acl";

/**
 * ACL 写入弹窗：先预演，再手打主体名，最后提交。
 *
 * 两步不是仪式。ACL 写错属于授权事故 —— 多一条是「谁能进来」，少一条是
 * 「谁掉线」，而服务端对这两种错误都不会有任何反馈。所以这一屏的重点不在于
 * 「把请求发出去」，而在于发之前把「会发生什么」摆出来：
 *
 * 1. 打开就预演：新增了什么、和谁冲突、会不会连自己都锁在外面；
 * 2. 有风险时勾一个「我知道」才放行，而不是禁用按钮 —— 这类操作有时正是要做的；
 * 3. 提交要求手打主体名。一次只能改一个主体，跨主体提交时这道确认形同虚设。
 *
 * 提交**不复用**预演结果：确认框可能开着几十秒，期间别人可能刚改过 ACL。
 * 后端在提交时重新读一遍全部规则再算 —— 这是它比界面更该被信任的原因。
 */
export function AclEntryEditor({
  open,
  draft,
  mode,
  onClose,
}: {
  open: boolean;
  /** `mode === "create"` 时是待新建的规则，`"delete"` 时要删的那条。 */
  draft: AclEntry | null;
  mode: "create" | "delete";
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const { previewCreate, previewDelete, commitCreate, commitDelete } = useAclWrite(connectionId);
  const [entry, setEntry] = useState<AclEntry | null>(draft);
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [plan, setPlan] = useState<AclChangePlan | null>(null);
  const [report, setReport] = useState<AclWriteReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = mode === "create" ? previewCreate : previewDelete;
  const commit = mode === "create" ? commitCreate : commitDelete;

  useEffect(() => {
    if (!open) return;
    setEntry(draft);
    setConfirm("");
    setAcknowledged(false);
    setPlan(null);
    setReport(null);
    setError(null);
    commit.reset();
    // 打开即预演：让「会发生什么」比输入框更早出现。
    if (draft) {
      runPreview(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  function runPreview(target: AclEntry) {
    setError(null);
    preview.mutate(
      { entries: [target], confirm: "" },
      {
        onSuccess: (result) => setPlan(result),
        onError: (failure) => setError(errorMessage(failure)),
      },
    );
  }

  function update(patch: Partial<AclEntry>) {
    if (!entry) return;
    const next = { ...entry, ...patch };
    // 切到通配时清掉名字：通配由模式表达，名字填了服务端不认。
    if (patch.pattern === "wildcard") next.resourceName = "";
    setEntry(next);
    setPlan(null);
    setReport(null);
    setConfirm("");
    setAcknowledged(false);
  }

  const target = entry ? confirmTarget([entry]) : null;
  const submit = entry ? canSubmit(plan ?? undefined, acknowledged) : false;
  const ready = submit && confirm.trim() === target && !commit.isPending;

  return (
    <Modal
      open={open}
      size="sm"
      title={mode === "create" ? "新建 ACL 规则" : "删除 ACL 规则"}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {report ? "关闭" : "取消"}
          </Button>
          {report ? null : (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!entry || preview.isPending}
                onClick={() => entry && runPreview(entry)}
              >
                {preview.isPending ? "预演中…" : "重新预演"}
              </Button>
              <Button
                size="sm"
                disabled={!ready}
                onClick={() => {
                  if (!entry) return;
                  commit.mutate(
                    { entries: [entry], confirm },
                    {
                      onSuccess: (result) => setReport(result),
                      onError: (failure) => setError(errorMessage(failure)),
                    },
                  );
                }}
              >
                {commit.isPending ? "提交中…" : mode === "create" ? "提交新增" : "确认删除"}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {report ? (
          <ReportView report={report} />
        ) : (
          <>
            {entry ? (
              <EntryForm entry={entry} mode={mode} onChange={update} />
            ) : null}

            {error ? <Callout tone="danger">{error}</Callout> : null}

            {plan ? (
              <PlanView plan={plan} />
            ) : preview.isPending ? (
              <p className="text-meta">正在预演这次提交…</p>
            ) : null}

            {plan && plan.blockers.length ? (
              <label className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-(length:--text-app-body) text-amber-800">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                />
                <span>我知道上述风险，仍要提交</span>
              </label>
            ) : null}

            {submit ? (
              <Field
                label={`手打主体名确认：${target ?? ""}`}
                hint={
                  entryPrincipalCount([entry as AclEntry]) > 1
                    ? "一次只能改一个主体的规则"
                    : "写错一条 ACL 是授权事故：多一条是「谁能进来」，少一条是「谁掉线」"
                }
              >
                <Input
                  value={confirm}
                  placeholder={target ?? ""}
                  onChange={(event) => setConfirm(event.currentTarget.value)}
                />
              </Field>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/** 单条规则的字段。删除时全部禁用 —— 要删的是哪一条不能改。 */
function EntryForm({
  entry,
  mode,
  onChange,
}: {
  entry: AclEntry;
  mode: "create" | "delete";
  onChange: (patch: Partial<AclEntry>) => void;
}) {
  const disabled = mode === "delete";
  return (
    <div className="flex flex-col gap-2">
      <Field label="主体" hint="形如 User:alice；写 User:* 表示所有用户">
        <Input
          value={entry.principal}
          disabled={disabled}
          onChange={(event) => onChange({ principal: event.currentTarget.value })}
        />
      </Field>
      <div className="flex gap-2">
        <Field label="资源类型">
          <Select
            value={entry.resourceType}
            disabled={disabled}
            onChange={(event) =>
              onChange({ resourceType: event.currentTarget.value as AclEntry["resourceType"] })
            }
          >
            {ACL_RESOURCE_TYPES.map((kind) => (
              <option key={kind} value={kind}>
                {ACL_RESOURCE_LABEL[kind]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="匹配方式">
          <Select
            value={entry.pattern}
            disabled={disabled}
            onChange={(event) => onChange({ pattern: event.currentTarget.value as AclEntry["pattern"] })}
          >
            <option value="literal">精确匹配</option>
            <option value="prefixed">前缀匹配</option>
            <option value="wildcard">全部资源</option>
          </Select>
        </Field>
      </div>
      {entry.pattern !== "wildcard" ? (
        <Field
          label="资源名"
          hint={entry.resourceType === "cluster" ? "集群级资源的名字只能是 kafka-cluster" : undefined}
        >
          <Input
            value={entry.resourceName}
            disabled={disabled}
            onChange={(event) => onChange({ resourceName: event.currentTarget.value })}
          />
        </Field>
      ) : null}
      <div className="flex gap-2">
        <Field label="操作">
          <Select
            value={entry.operation}
            disabled={disabled}
            onChange={(event) => onChange({ operation: event.currentTarget.value as AclEntry["operation"] })}
          >
            {ACL_OPERATION_OPTIONS.map((operation) => (
              <option key={operation} value={operation}>
                {ACL_OPERATION_LABEL[operation]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="权限">
          <Select
            value={entry.permission}
            disabled={disabled}
            onChange={(event) =>
              onChange({ permission: event.currentTarget.value as AclEntry["permission"] })
            }
          >
            {ACL_PERMISSION_OPTIONS.map((permission) => (
              <option key={permission} value={permission}>
                {ACL_PERMISSION_LABEL[permission]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="来源主机" hint="`*` 表示不限来源，比限定 IP 宽">
        <Input
          value={entry.host}
          disabled={disabled}
          onChange={(event) => onChange({ host: event.currentTarget.value })}
        />
      </Field>
    </div>
  );
}

/** 预演结果：一条一行，冲突与覆盖必须把相干的规则点出来。 */
function PlanView({ plan }: { plan: AclChangePlan }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-(length:--text-app-body) text-slate-700">{planVerdict(plan)}</p>
      {plan.blockers.map((blocker) => (
        <Callout key={blocker} tone="danger">
          {blocker}
        </Callout>
      ))}
      <div className="flex flex-col gap-1.5">
        {plan.changes.map((change) => (
          <div key={`${change.entry.principal}|${change.verdict}`} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge tone={changeTone(change.verdict)}>{ACL_CHANGE_LABEL[change.verdict]}</Badge>
              <span className="font-mono text-meta">{change.entry.principal}</span>
            </div>
            {change.related.map((line) => (
              <p key={line} className="text-meta">
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>
      {plan.notes.map((note) => (
        <p key={note} className="text-meta">
          {note}
        </p>
      ))}
    </div>
  );
}

/** 提交回执：失败的条目单独列出来，别让「3 成功 1 失败」被一眼扫过去。 */
function ReportView({ report }: { report: AclWriteReport }) {
  const failed = report.outcomes.filter((item) => !item.ok);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-(length:--text-app-body) text-slate-700">{reportVerdict(report)}</p>
      {failed.length ? (
        <Callout tone="danger">
          失败的是这一条：
          {failed.map((item) => ` ${item.entry.principal}（${item.message}）`).join("；")}
        </Callout>
      ) : null}
      {report.notes.map((note) => (
        <p key={note} className="text-meta">
          {note}
        </p>
      ))}
    </div>
  );
}
