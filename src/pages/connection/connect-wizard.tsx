import { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, Server } from "lucide-react";

import { Button, Field, Input, Modal } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { BROKER_LABEL } from "@/lib/nav";
import { clearDraft, type SavedConnection } from "@/lib/session-storage";
import type { BrokerKind, ConnectionConfig } from "@/types";

import { ConnectionFormKafka } from "./forms/kafka-form";
import { ConnectionFormRabbitMq } from "./forms/rabbitmq-form";

/**
 * 新建连接向导：先选中间件，下一步再填参数。
 *
 * 为什么是两步而不是一张「类型下拉 + 表单」的长弹窗：
 *
 * - 选类型只有两三个选项，是一次**选择**；填参数是一段**工作**。挤在同一屏时，
 *   表单会先于用户做决定就摊开，字段看上去像是已经选好了 —— 用户得先扫一遍
 *   不需要的字段，才想起上面还有个下拉框；
 * - 两步之后，第一步只回答「连哪种」，第二步接管键盘焦点到第一个输入框，
 *   回车就提交。字段再多也不会有「这一页到底从哪开始」的问题。
 *
 * 编辑已有记录时不走向导，直接进第二步：类型已经定下来了，再让用户从两张卡片里
 * 点一次是多余的动作。
 */

/** 向导的第二步：哪台机器 + 要预填哪一条记录。 */
type Picked = {
  kind: BrokerKind;
  /** 非空表示从连接记录里「编辑」，此时带原名、原配置。 */
  saved?: SavedConnection;
  name: string;
};

export function ConnectWizard({
  open,
  /** 初始中间件：只用来在第一步里预先高亮一张卡片。 */
  initialKind,
  /** 初始要编辑的记录；有值时跳过第一步，直接进表单。 */
  initialSaved,
  onClose,
}: {
  open: boolean;
  initialKind?: BrokerKind | null;
  initialSaved?: SavedConnection | null;
  onClose: () => void;
}) {
  const openConnection = useOpenConnection();
  const [save, setSave] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(() =>
    initialSaved && !initialKind ? savedToPicked(initialSaved) : null,
  );

  const busy = openConnection.isPending;
  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  const submit = (config: ConnectionConfig) => {
    const name = picked?.name.trim() || defaultName(config);
    openConnection.mutate(
      { name, config, save },
      {
        onSuccess: () => {
          // 连上了就说明配置有效，草稿没用了，免得下次残留半成品。
          clearDraft(config.kind);
          setSave(false);
          onClose();
        },
      },
    );
  };

  // 关掉再打开时要回到初始步骤：这是向导自身的状态，上一轮的「选了 Kafka」
  // 不该带给下一次新建。
  // 传了 `initialKind` 的入口（首页卡片、顶栏「＋」→ 选类型）表示「类型已经定了一部分」，
  // 仍然从选类型那一步开始，方便换一个；只有编辑记录才直接落在第二步。
  const step: "kind" | "form" = initialSaved || picked ? "form" : "kind";
  const kind = picked?.kind ?? initialSaved?.config.kind ?? null;

  return (
    <Modal
      open={open}
      size="sm"
      title={step === "kind" ? "新建连接" : `连接 ${kind ? BROKER_LABEL[kind] : ""}`}
      onClose={close}
      footer={
        step === "kind" ? (
          // 第一步没有提交动作：选中卡片就直接进入第二步，按钮只留一个退出口。
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
        ) : (
          <>
            {/* 新建时能退回第一步换类型；编辑记录时退回去没有意义。 */}
            {picked?.saved || initialSaved || !picked ? null : (
              <Button variant="ghost" onClick={() => setPicked(null)} disabled={busy}>
                <ArrowLeft className="size-3.5" />
                上一步
              </Button>
            )}
            <Button variant="ghost" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button type="submit" form={FORM_ID} loading={busy}>
              连接
            </Button>
          </>
        )
      }
    >
      {step === "kind" ? (
        <KindStep
          onPick={(next) => setPicked({ kind: next, name: "" })}
          selected={kind}
        />
      ) : kind ? (
        <FormStep
          // 换类型 / 换记录时整套重建表单：输入框里不能留着上一条的地址。
          key={`${kind}:${picked?.saved?.id ?? initialSaved?.id ?? "new"}`}
          picked={picked}
          kind={kind}
          save={save}
          onSaveChange={setSave}
          onSubmit={submit}
          initialSaved={initialSaved ?? null}
          onNameChange={(name) => setPicked((prev) => ({ ...(prev ?? { kind, name }), name }))}
        />
      ) : null}
    </Modal>
  );
}

/** 第一步：选一种中间件。整张卡片可点，点下去直接进第二步。 */
function KindStep({
  selected,
  onPick,
}: {
  selected: BrokerKind | null;
  onPick: (kind: BrokerKind) => void;
}) {
  const { data: plugins } = usePluginKinds();
  const list = plugins ?? [{ kind: "kafka" as BrokerKind, displayName: "Kafka", capabilities: [] }];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
        先选一种中间件，下一步填它的连接地址与凭据。
      </p>
      <div className="flex flex-col gap-2" role="listbox" aria-label="选择中间件">
        {list.map((plugin) => (
          <button
            key={plugin.kind}
            type="button"
            role="option"
            aria-selected={selected === plugin.kind}
            data-kind={plugin.kind}
            onClick={() => onPick(plugin.kind)}
            className={cn(
              "group flex items-center gap-3 rounded-xl bg-white p-3 text-left transition-colors",
              "ring-1 ring-slate-200 hover:ring-indigo-400",
              selected === plugin.kind && "ring-indigo-500 bg-indigo-50/40",
            )}
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                plugin.kind === "kafka"
                  ? "bg-amber-50 text-broker-kafka"
                  : "bg-violet-50 text-broker-rabbitmq",
              )}
            >
              <Server className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="text-(length:--text-app-body) font-semibold text-slate-900">
                  {plugin.displayName}
                </span>
                <span className="text-(length:--text-app-micro) text-meta">
                  默认端口 {DEFAULT_PORT[plugin.kind]}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-(length:--text-app-meta) text-meta">
                {KIND_SUMMARY[plugin.kind]}
              </span>
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-meta transition-colors group-hover:text-indigo-600" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** 第二步：连接名 + 参数表单。 */
function FormStep({
  picked,
  kind,
  save,
  onSaveChange,
  onSubmit,
  initialSaved,
  onNameChange,
}: {
  picked: Picked | null;
  kind: BrokerKind;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  onSubmit: (config: ConnectionConfig) => void;
  initialSaved: SavedConnection | null;
  onNameChange: (name: string) => void;
}) {
  const saved = picked?.saved ?? initialSaved;
  const editing = Boolean(saved);
  // 表单初值：优先用那一条记录，其次交给表单自己读草稿 / 默认值。
  const initialConfig = saved ? saved.config : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
        {KIND_SUMMARY[kind]}
        {editing ? " · 改完保存会覆盖同名同类型的记录" : ""}
      </p>

      <Field label="连接名称（可选）" hint="同名同类型会覆盖已保存的连接">
        <Input
          value={picked?.name ?? saved?.name ?? ""}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder={kind === "kafka" ? "例如：本地 Kafka" : "例如：本地 RabbitMQ"}
          autoFocus
        />
      </Field>

      {kind === "kafka" ? (
        <ConnectionFormKafka
          formId={FORM_ID}
          onSubmit={onSubmit}
          save={save}
          onSaveChange={onSaveChange}
          initialConfig={initialConfig?.kind === "kafka" ? initialConfig : null}
        />
      ) : (
        <ConnectionFormRabbitMq
          formId={FORM_ID}
          onSubmit={onSubmit}
          save={save}
          onSaveChange={onSaveChange}
          initialConfig={initialConfig?.kind === "rabbitMq" ? initialConfig : null}
        />
      )}
    </div>
  );
}

/** 一条保存过的记录 → 向导第二步的形态（带原名与原配置）。 */
function savedToPicked(saved: SavedConnection): Picked {
  return { kind: saved.config.kind, saved, name: saved.name };
}

/** 弹窗页脚的提交按钮靠 `form` 属性接回滚动区里的表单。 */
const FORM_ID = "connect-form";

/** 每种中间件的默认端口；只是提示，真实值由表单决定。 */
const DEFAULT_PORT: Record<BrokerKind, string> = {
  kafka: "9092",
  rabbitMq: "15672（管理 API）",
};

/** 每种中间件一句人话。文案属于界面，不进后端清单。 */
const KIND_SUMMARY: Record<BrokerKind, string> = {
  kafka: "主题、分区、消费组与位点",
  rabbitMq: "队列、交换机、绑定与消息处置",
};

/** 没填名字时的默认名：端点已经单列在记录行第二行，名字里不再重复地址。 */
function defaultName(config: ConnectionConfig): string {
  return config.kind === "kafka" ? "Kafka" : "RabbitMQ";
}
