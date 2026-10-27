import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";

import { Button, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { useSaveParameter } from "@/hooks/use-parameters";
import {
  COMPONENT_OPTIONS,
  componentLabel,
  isKnownComponent,
  requiresDefaultVhost,
  templateFor,
  vhostAfterSwitch,
} from "@/lib/parameter";
import { parameterService } from "@/services";
import type { ParameterComponent, ParameterInfo, ParameterReview, ParameterSpec } from "@/types/parameter";

/** 空表单的初值。`vhost` 留空由页面补当前连接的 vhost。 */
function emptySpec(defaultVhost: string): ParameterSpec {
  return {
    component: "federation-upstream",
    vhost: defaultVhost,
    name: "",
    value: templateFor("federation-upstream"),
  };
}

/**
 * 参数编辑弹窗。
 *
 * 与策略编辑不同，这里没有「影响面预览」——参数只作用于它自己，
 * 不会误伤别的资源。真正需要提前说清的是另外两件事：
 * 1. 这个组件的形状要求（服务端报错是一串 Erlang 术语）；
 * 2. 改错 / 删除的后果（联邦和铲子出错是静默的：消息只是不再搬了）。
 *
 * 所以保存前先跑一次后端校验（`review_parameter_spec`），
 * 阻断项挡住按钮，提醒项列在按钮上方。
 */
export function ParameterEditor({
  open,
  parameter,
  defaultVhost,
  canWrite,
  onClose,
}: {
  open: boolean;
  /** 非空表示编辑既有参数，空表示新建。 */
  parameter: ParameterInfo | null;
  defaultVhost: string;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const save = useSaveParameter(connectionId);
  const [spec, setSpec] = useState<ParameterSpec>(() => emptySpec(defaultVhost));
  const [review, setReview] = useState<ParameterReview | null>(null);
  const [reviewing, setReviewing] = useState(false);

  // 弹窗常驻，只在 open / 目标变化时重置。
  useEffect(() => {
    if (!open) return;
    save.reset();
    setReview(null);
    if (parameter) {
      setSpec({
        // 未知组件（插件注册的）无法用下拉表达，退回第一个已知组件只为让表单可用；
        // 编辑时组件不可改，所以这条支路实际不会被提交。
        component: isKnownComponent(parameter.component)
          ? parameter.component
          : "federation-upstream",
        vhost: parameter.vhost,
        name: parameter.name,
        value: JSON.stringify(parameter.value, null, 2),
      });
    } else {
      setSpec(emptySpec(defaultVhost));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, parameter, defaultVhost]);

  const update = (patch: Partial<ParameterSpec>) => {
    setSpec((prev) => ({ ...prev, ...patch }));
    // 任何改动都会让上一次的校验结论过期，直接清掉，避免「按旧结论保存」。
    setReview(null);
  };

  const switchComponent = (component: ParameterComponent) => {
    update({
      component,
      vhost: vhostAfterSwitch(component, spec.vhost),
      // 只在新表单（没在编辑已存在的参数）时换模板，避免把已有内容冲掉。
      value: parameter || spec.value.trim() ? spec.value : templateFor(component),
    });
  };

  const runReview = async () => {
    setReviewing(true);
    try {
      setReview(await parameterService.reviewParameter(spec));
    } finally {
      setReviewing(false);
    }
  };

  const blocking = Boolean(review?.errors.length);
  const dirtyName = parameter && parameter.name !== spec.name.trim();
  const canSave = canWrite && !blocking && spec.name.trim().length > 0 && !save.isPending;

  const hint = useMemo(
    () => COMPONENT_OPTIONS.find((option) => option.value === spec.component)?.hint,
    [spec.component],
  );

  return (
    <Modal
      open={open}
      title={`${parameter ? "编辑" : "新建"}参数${parameter ? ` · ${componentLabel(parameter.component)}` : ""}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="secondary" disabled={reviewing} onClick={() => void runReview()}>
            {reviewing ? "校验中…" : "校验"}
          </Button>
          <Button
            disabled={!canSave}
            title={
              canWrite
                ? blocking
                  ? "校验未通过"
                  : undefined
                : "当前账号没有管理 API 写权限"
            }
            onClick={() =>
              save.mutate(
                {
                  spec: { ...spec, name: spec.name.trim() },
                  originalName: parameter?.name,
                },
                { onSuccess: onClose },
              )
            }
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-auto px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="类型" hint={hint}>
            <Select
              value={spec.component}
              disabled={Boolean(parameter)}
              onChange={(event) => switchComponent(event.currentTarget.value as ParameterComponent)}
            >
              {COMPONENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="vhost"
            hint={
              requiresDefaultVhost(spec.component)
                ? "节点级参数只认默认 vhost `/`"
                : "跟随业务 vhost，留空表示 `/`"
            }
          >
            <Input
              value={spec.vhost}
              disabled={requiresDefaultVhost(spec.component)}
              onChange={(event) => update({ vhost: event.currentTarget.value })}
              placeholder="/"
            />
          </Field>
        </div>

        <Field
          label="名称"
          hint={dirtyName ? `保存后会先建 ${spec.name.trim()} 再删除旧的 ${parameter?.name}` : undefined}
        >
          {/* 编辑时组件不可改：管理 API 没有跨组件移动语义。 */}
          <Input
            value={spec.name}
            onChange={(event) => update({ name: event.currentTarget.value })}
            placeholder="如 up-remote"
            className="font-mono"
          />
        </Field>

        <Field
          label="值（JSON）"
          hint="服务端不校验字段拼写：写错不会报错，只会一直连不上，所以这里要看清"
        >
          <Textarea
            value={spec.value}
            onChange={(event) => update({ value: event.currentTarget.value })}
            rows={14}
            spellCheck={false}
            className="text-xs leading-relaxed"
          />
        </Field>

        {review ? <ReviewBlock review={review} /> : null}
      </div>
    </Modal>
  );
}

/** 校验结论：阻断项在前（红），提醒项在后（黄）。 */
function ReviewBlock({ review }: { review: ParameterReview }) {
  if (!review.errors.length && !review.caveats.length) {
    return <p className="text-xs text-emerald-700">校验通过，可以保存</p>;
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      {review.errors.map((message) => (
        <p key={message} className="text-rose-700">
          阻断：{message}
        </p>
      ))}
      {review.caveats.map((message) => (
        <p key={message} className="text-amber-700">
          注意：{message}
        </p>
      ))}
    </div>
  );
}
