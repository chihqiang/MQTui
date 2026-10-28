import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";

import { Badge, Button, Field, Input, Modal, Select } from "@/components/ui";
import { usePolicyPreview, useSavePolicy } from "@/hooks/use-policies";
import {
  APPLY_TO_OPTIONS,
  describeImpact,
  COMMON_DEFINITION_KEYS,
  emptySpec,
  fromRows,
  isDirty,
  specFromPolicy,
  toRows,
  validateSpec,
  type DefinitionRow,
} from "@/lib/policy";
import type { ImpactConfidence, PolicyInfo, PolicySpec } from "@/types/policy";

/**
 * 策略编辑弹窗。
 *
 * 设计目标只有一个：让人在保存之前就看清后果。策略本身写错不会报错，
 * 只是「静默不生效」或「误伤了别的队列」—— 这两种失败都得靠界面提前说出来。
 *
 * 所以保存流程固定为：填表 → 预览影响（影响面 + 优先级冲突 + 注意事项）→ 保存。
 * 不预览也能存，但按钮上会写明「未预览」。
 */
export function PolicyEditor({
  open,
  policy,
  canWrite,
  onClose,
}: {
  open: boolean;
  /** 非空表示编辑既有策略，空表示新建。 */
  policy: PolicyInfo | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const save = useSavePolicy(connectionId);
  const preview = usePolicyPreview(connectionId);
  const [spec, setSpec] = useState<PolicySpec>(emptySpec);
  const [rows, setRows] = useState<DefinitionRow[]>([]);

  // 弹窗是常驻组件，只有 open / 目标策略变化时重置表单。
  // 编辑时把原值存进 `value`，`draft` 留给用户改，便于标出「这一行被改过」。
  useEffect(() => {
    if (!open) return;
    const next = policy ? specFromPolicy(policy) : emptySpec();
    setSpec(next);
    setRows(toRows(next.definition));
    preview.reset();
    save.reset();
    // preview / save 是稳定的 mutation 对象，不参与依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, policy]);

  const definition = useMemo(() => fromRows(rows), [rows]);
  const effectiveSpec: PolicySpec = { ...spec, definition };
  const localError = useMemo(() => validateSpec(effectiveSpec), [effectiveSpec]);
  const renamed = Boolean(policy && policy.name !== spec.name);
  const dirtyRows = rows.filter(isDirty).length;

  const submit = () => {
    if (localError) return;
    save.mutate({ spec: effectiveSpec, originalName: policy?.name });
  };

  return (
    <Modal
      open={open}
      title={policy ? `编辑策略 ${policy.name}` : "新建策略"}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={preview.isPending}
            disabled={Boolean(localError)}
            onClick={() => preview.mutate(effectiveSpec)}
          >
            预览影响
          </Button>
          <Button
            size="sm"
            loading={save.isPending}
            disabled={!canWrite || Boolean(localError)}
            title={canWrite ? undefined : "当前账号没有管理 API 写权限"}
            onClick={submit}
          >
            {renamed ? "重命名并保存" : "保存"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="名称"
            hint={
              renamed
                ? `原名称 ${policy?.name} 会被删除（先建新的、再删旧的）`
                : "同名策略会被整体替换，不是合并"
            }
          >
            <Input
              value={spec.name}
              required
              placeholder="orders-ttl"
              onChange={(event) => setSpec({ ...spec, name: event.currentTarget.value })}
            />
          </Field>
          <Field label="优先级" hint="数字越大越优先；同范围下低优先级会静默失效">
            <Input
              type="number"
              value={spec.priority}
              onChange={(event) =>
                setSpec({ ...spec, priority: Number(event.currentTarget.value) || 0 })
              }
            />
          </Field>
        </div>

        <Field label="匹配模式（正则）" hint="留空等价于 .*，会命中全部资源；按名称匹配，不是按内容">
          <Input
            value={spec.pattern}
            placeholder="^orders\."
            onChange={(event) => setSpec({ ...spec, pattern: event.currentTarget.value })}
          />
        </Field>

        <Field label="生效范围">
          <Select
            value={spec.applyTo}
            onChange={(event) =>
              setSpec({ ...spec, applyTo: event.currentTarget.value as PolicySpec["applyTo"] })
            }
          >
            {APPLY_TO_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} —— {option.hint}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-center justify-between">
          <span className="text-(length:--text-app-body) text-slate-500">
            定义（{definition.length} 项）
            {dirtyRows > 0 ? (
              <span className="ml-2 text-amber-700">{dirtyRows} 行有改动</span>
            ) : null}
          </span>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRows([...rows, { key: "", value: "", draft: "" }])}
            >
              添加一行
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {rows.map((row, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1">
                <Input
                  value={row.key}
                  placeholder="x-message-ttl"
                  list="policy-keys"
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, key: event.currentTarget.value };
                    setRows(next);
                  }}
                />
              </div>
              <div className="flex-1">
                <Input
                  value={row.draft}
                  placeholder="60000"
                  onChange={(event) => {
                    const next = [...rows];
                    next[index] = { ...row, draft: event.currentTarget.value };
                    setRows(next);
                  }}
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRows(rows.filter((_, position) => position !== index))}
              >
                删除
              </Button>
            </div>
          ))}
          <datalist id="policy-keys">
            {COMMON_DEFINITION_KEYS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </datalist>
          {rows.length === 0 ? (
            <p className="text-(length:--text-app-body) text-slate-500">
              还没有定义项。空定义的策略不产生任何效果，服务端也会拒绝。
            </p>
          ) : null}
        </div>

        {localError ? <p className="text-(length:--text-app-body) text-rose-700">{localError}</p> : null}

        <PreviewBlock
          preview={preview.data}
          error={preview.error ? String(preview.error) : null}
          pending={preview.isPending}
        />
      </form>
    </Modal>
  );
}

/**
 * 预览结论区。
 *
 * 三条信息缺一不可：
 * 1. 影响面 —— 「这个模式会碰到多少资源」；
 * 2. 优先级冲突 —— 策略不会报错、只是不生效，这是最隐蔽的失败；
 * 3. 注意事项 —— 作用域误伤、只对之后声明的资源生效。
 */
function PreviewBlock({
  preview,
  error,
  pending,
}: {
  preview:
    | {
        impact: { queues: number; exchanges: number; confidence: ImpactConfidence };
        conflicts: { name: string; priority: number; detail: string }[];
        caveats: string[];
        patternNote?: string | null;
      }
    | undefined;
  error: string | null;
  pending: boolean;
}) {
  if (pending) return <p className="text-(length:--text-app-body) text-slate-500">正在估算影响面…</p>;
  if (error) return <p className="text-(length:--text-app-body) text-rose-700">预览失败：{error}</p>;
  if (!preview) {
    return (
      <p className="text-(length:--text-app-body) text-slate-500">
        点「预览影响」可以看清这条策略会碰哪些资源、以及是否会被别的策略压制
      </p>
    );
  }

  const { impact, conflicts, caveats, patternNote } = preview;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-(length:--text-app-body)">
      <p className="text-slate-600">
        影响面：
        <span className="text-amber-700">{describeImpact(impact)}</span>
        <span className="ml-1 text-slate-500">（按名称估算，实际命中以服务端为准）</span>
      </p>

      {/* 模式读不准时，「约 N 个」这个数字本身就是不可信的，必须单独说一句：
          说「约 1 个」和说「我不知道」，对看确认框的人是两件事。 */}
      {patternNote ? (
        <p className="flex items-start gap-1.5 text-amber-700">
          <Badge tone="warning">估不准</Badge>
          <span className="flex-1">{patternNote}</span>
        </p>
      ) : null}

      {conflicts.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-amber-700">会被这些策略压制（同级或更低的策略不会生效）：</p>
          {conflicts.map((conflict) => (
            <p key={conflict.name} className="text-slate-500">
              · {conflict.detail}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-slate-500">没有更高优先级的策略覆盖同一范围</p>
      )}

      <div className="flex flex-col gap-1">
        {caveats.map((caveat) => (
          <p key={caveat} className="flex items-start gap-1.5 text-slate-500">
            <Badge tone="warning">注意</Badge>
            <span className="flex-1">{caveat}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
