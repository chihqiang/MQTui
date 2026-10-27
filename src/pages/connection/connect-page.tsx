import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Plug, Server, Trash2 } from "lucide-react";

import { Button, Card, Field, Input, Modal } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { BROKER_LABEL } from "@/lib/nav";
import {
  clearDraft,
  deleteSavedConnection,
  getSavedConnection,
  listSavedConnections,
  type SavedConnection,
} from "@/lib/session-storage";
import type { BrokerKind, ConnectionConfig, SaslMechanism, TlsMode } from "@/types";

import { ConnectionFormKafka } from "./forms/kafka-form";
import { ConnectionFormRabbitMq } from "./forms/rabbitmq-form";

/**
 * 首页：选一种中间件，弹窗里填连接信息。
 *
 * 形态上刻意**不**做「连接记录 / 新建连接」两个页签：
 *
 * - 页签把「选类型」和「填参数」摊在同一屏，选 Kafka 之后表单就等在旁边，
 *   用户得先看懂这一页有几块内容，才知道从哪开始；
 * - 而选中间件本质上只有两三个选项，是一次选择、不是一段状态。
 *
 * 现在版面只回答一个问题：连哪种？点卡片 → 弹窗 → 填完就连。
 * 连过的环境仍然留在同一页下方，但它是「历史」，不再和新建抢视觉重量。
 */

/** 每种中间件一句人话 + 默认端口。文案属于界面，不进后端清单。 */
const KIND_HINT: Record<BrokerKind, { summary: string; port: string }> = {
  kafka: { summary: "主题、分区、消费组与位点", port: "9092" },
  rabbitMq: { summary: "队列、交换机、绑定与消息处置", port: "15672（管理 API）" },
};

/** 弹窗当前要连的目标；`saved` 非空表示从连接记录里打开的（带原名与预填配置）。 */
type Target = {
  kind: BrokerKind;
  saved?: SavedConnection;
  /** 从「重连/补口令」进来时直接开弹窗，里面已填好那一条。 */
  name: string;
};

export function ConnectPage() {
  const { data: plugins } = usePluginKinds();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [target, setTarget] = useState<Target | null>(null);
  const [save, setSave] = useState(false);
  // 已保存列表是 localStorage 而非服务端数据，用一次读取 + 手动刷新保持简单。
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  const openConnection = useOpenConnection();

  /**
   * 正在连的那一条记录。
   *
   * `openConnection` 是全局一个 mutation，把 `isPending` 直接传给每一行，
   * 点击时全部记录一起转圈 —— 看不出到底在连哪台。这里记住被点的那条。
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    if (!openConnection.isPending) setPendingId(null);
  }, [openConnection.isPending]);

  const closeDialog = useCallback(() => {
    if (openConnection.isPending) return;
    setTarget(null);
  }, [openConnection.isPending]);

  const submit = (config: ConnectionConfig) => {
    const name = target?.name || defaultName(config);
    openConnection.mutate(
      { name, config, save },
      {
        onSuccess: (summary) => {
          // 连上了就说明配置有效，草稿没用了，清掉免得下次残留半成品。
          clearDraft(config.kind);
          setSave(false);
          setTarget(null);
          setSaved(listSavedConnections());
          // 弹窗开着连上之后自动落进工作区：用户填完信息是为了看数据，
          // 不是为了回到这页看到一句「已连接」。
          navigate(`/connections/${summary.id}`);
        },
      },
    );
  };

  /** 记录行上的「重连」：直接连，不弹窗、不用重填。 */
  const reconnect = useCallback(
    (entry: SavedConnection) => {
      setPendingId(entry.id);
      openConnection.mutate(
        { name: entry.name, config: entry.config },
        { onSuccess: (summary) => navigate(`/connections/${summary.id}`) },
      );
    },
    [navigate, openConnection],
  );

  /**
   * 记录行上的「编辑连接」：缺密码、想改端口时走这条路。
   *
   * 弹窗里带着那一条的原名与原配置 —— 同名同类型会覆盖保存，所以改完直接落回同一条记录。
   */
  const editSaved = useCallback((entry: SavedConnection) => {
    setTarget({ kind: entry.config.kind, saved: entry, name: entry.name });
  }, []);

  const removeSaved = useCallback((entry: SavedConnection) => {
    deleteSavedConnection(entry.id);
    setSaved(listSavedConnections());
  }, []);

  // `?resume=<id>` 来自「连接不存在」页的重连按钮：自动带上已保存的配置再连一次。
  const resumeId = searchParams.get("resume");
  const pendingResume = resumeId ? getSavedConnection(resumeId) : null;
  useEffect(() => {
    if (!pendingResume) return;
    setSearchParams({}, { replace: true });
    openConnection.mutate(
      { name: pendingResume.name, config: pendingResume.config },
      { onSuccess: (summary) => navigate(`/connections/${summary.id}`) },
    );
  }, [pendingResume, openConnection, setSearchParams, navigate]);

  const pluginList = useMemo(
    () => plugins ?? [{ kind: "kafka" as BrokerKind, displayName: "Kafka", capabilities: [] }],
    [plugins],
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <h1 className="text-(length:--text-app-display) font-semibold tracking-tight text-slate-900">
          开始使用
        </h1>
        <p className="mt-1 text-(length:--text-app-body) leading-relaxed text-slate-500">
          选择要连接的中间件，在弹出的窗口里填连接信息
        </p>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {pluginList.map((plugin) => (
            <KindCard
              key={plugin.kind}
              kind={plugin.kind}
              displayName={plugin.displayName}
              onPick={() => setTarget({ kind: plugin.kind, name: "" })}
            />
          ))}
        </div>

        <div className="mt-7">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-(length:--text-app-body) font-semibold text-slate-800">连接记录</h2>
            <span className="text-(length:--text-app-meta) text-meta">
              {saved.length > 0 ? "点「重连」直接接回去" : "连过一次之后会留在这里"}
            </span>
          </div>

          {saved.length === 0 ? (
            <EmptySaved />
          ) : (
            <ul className="flex flex-col gap-2">
              {saved.map((entry) => (
                <li key={entry.id}>
                  <SavedRow
                    entry={entry}
                    busy={pendingId === entry.id}
                    onReconnect={() => reconnect(entry)}
                    onEdit={() => editSaved(entry)}
                    onRemove={() => removeSaved(entry)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 弹窗按 key 重建：换一条记录 / 换一种中间件时表单状态必须整套换掉，
          否则会看到上一条的地址留在输入框里。 */}
      {target ? (
        <ConnectDialog
          key={`${target.kind}:${target.saved?.id ?? "new"}`}
          target={target}
          submitting={openConnection.isPending}
          save={save}
          onSaveChange={setSave}
          onSubmit={submit}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  );
}

/**
 * 填连接信息的弹窗。
 *
 * 抽出来是为了 `key` 能重建它 —— 表单的初值来自草稿或已保存记录，
 * 只在挂载时读一次。
 */
function ConnectDialog({
  target,
  submitting,
  save,
  onSaveChange,
  onSubmit,
  onClose,
}: {
  target: Target;
  submitting: boolean;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  onSubmit: (config: ConnectionConfig) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(target.name);
  const hint = KIND_HINT[target.kind];
  const editing = Boolean(target.saved);

  return (
    <Modal
      open
      size="sm"
      title={`连接 ${BROKER_LABEL[target.kind]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          {/* 表单本体在滚动区里，提交按钮放在页脚才不会随字段增减跑掉。
              靠 form 属性把页脚按钮接回弹窗里的 <form>。 */}
          <Button type="submit" form={FORM_ID} loading={submitting}>
            连接
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
          {hint.summary}
          {editing ? " · 改完保存会覆盖同名同类型的记录" : ""}
        </p>

        <Field label="连接名称（可选）" hint="同名同类型会覆盖已保存的连接">
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={target.kind === "kafka" ? "例如：本地 Kafka" : "例如：本地 RabbitMQ"}
            autoFocus
          />
        </Field>

        {target.kind === "kafka" ? (
          <ConnectionFormKafka
            formId={FORM_ID}
            onSubmit={onSubmit}
            save={save}
            onSaveChange={onSaveChange}
            initialConfig={target.saved?.config.kind === "kafka" ? target.saved.config : null}
          />
        ) : (
          <ConnectionFormRabbitMq
            formId={FORM_ID}
            onSubmit={onSubmit}
            save={save}
            onSaveChange={onSaveChange}
            initialConfig={target.saved?.config.kind === "rabbitMq" ? target.saved.config : null}
          />
        )}
      </div>
    </Modal>
  );
}

/** 弹窗里表单的 id：页脚按钮靠它提交滚动区里的表单。 */
const FORM_ID = "connect-form";

/** 一张中间件卡片：整张可点，点下去就开弹窗。 */
function KindCard({
  kind,
  displayName,
  onPick,
}: {
  kind: BrokerKind;
  displayName: string;
  onPick: () => void;
}) {
  const hint = KIND_HINT[kind] ?? { summary: "", port: "" };
  return (
    <button
      type="button"
      data-kind={kind}
      onClick={onPick}
      className={cn(
        "group flex items-center gap-3 rounded-xl bg-white p-3.5 text-left transition-colors",
        "ring-1 ring-slate-200 hover:ring-indigo-300",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          kind === "kafka" ? "bg-amber-50 text-broker-kafka" : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <Server className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-(length:--text-app-body) font-semibold text-slate-900">
            {displayName}
          </span>
          <span className="text-(length:--text-app-micro) text-meta">端口 {hint.port}</span>
        </span>
        <span className="mt-0.5 block truncate text-(length:--text-app-meta) text-meta">
          {hint.summary}
        </span>
      </span>
      {/* 箭头只在悬停时上色：两张大白卡常驻一个主色按钮，会把「选一个」变成「点按钮」。 */}
      <ArrowRight className="size-3.5 shrink-0 text-meta transition-colors group-hover:text-indigo-600" />
    </button>
  );
}

/** 一条连接记录。地址、用户名、是否存了密码都在行上，不用点开才知道。 */
function SavedRow({
  entry,
  busy,
  onReconnect,
  onEdit,
  onRemove,
}: {
  entry: SavedConnection;
  busy: boolean;
  onReconnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const config = entry.config;
  const endpoint =
    config.kind === "kafka"
      ? config.brokers.join(", ")
      : `${config.host}:${config.port}${config.managementUrl ? ` · ${config.managementUrl}` : ""}`;
  const user = config.auth.username?.trim();
  // 存下来的凭据缺口令时，「重连」一定失败。与其让人点了收到一句报错，
  // 不如在行上直接标出来，并把主动作换成「补口令」。
  const missingSecret = Boolean(user) && !config.auth.password;

  return (
    <Card className="flex items-center gap-3 px-3 py-2 transition-colors hover:ring-slate-300">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          config.kind === "kafka" ? "bg-amber-50 text-broker-kafka" : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <Plug className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* 第一行：名字 + 类型 + 用户；第二行：端点。信息分两层，扫读先认名字。 */}
        <p className="flex items-baseline gap-2 truncate text-(length:--text-app-body) font-medium text-slate-900">
          <span className="truncate">{entry.name}</span>
          <span className="shrink-0 text-(length:--text-app-micro) font-normal text-meta">
            {BROKER_LABEL[config.kind]}
          </span>
          {user ? (
            <span className="shrink-0 text-(length:--text-app-micro) font-normal text-meta">
              · {user}
            </span>
          ) : null}
          {missingSecret ? (
            <span className="shrink-0 rounded bg-amber-50 px-1 text-(length:--text-app-micro) font-normal text-warning">
              未存口令
            </span>
          ) : null}
        </p>
        <p className="truncate font-mono text-(length:--text-app-meta) text-meta">{endpoint}</p>
      </div>
      {/* 一行里只留一个主色按钮：记录列表竖着排十行时，十个实心主色按钮
          会连成一条比内容还显眼的色带。 */}
      <Button size="sm" variant="ghost" onClick={onEdit}>
        {missingSecret ? "补口令" : "编辑连接"}
      </Button>
      <Button
        size="sm"
        variant={missingSecret ? "secondary" : "primary"}
        loading={busy}
        onClick={onReconnect}
      >
        重连
      </Button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`从记录里删除 ${entry.name}`}
        className="shrink-0 rounded-md p-1.5 text-meta transition-colors hover:bg-rose-50 hover:text-rose-600"
      >
        <Trash2 className="size-3.5" />
      </button>
    </Card>
  );
}

function EmptySaved() {
  return (
    // 空态是**引导**而不是一块占位：一句标题 + 一句说明即可，
    // 上面的中间件卡片本来就是下一步能点的东西，这里不再放第二个按钮。
    <div className="flex items-center gap-3 rounded-xl bg-white px-3 py-3 ring-1 ring-slate-200">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-secondary">
        <Plug className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-(length:--text-app-body) font-medium text-slate-800">
          还没有连过的环境
        </p>
        <p className="text-(length:--text-app-meta) text-meta">
          连上一次之后，这里会留下地址与用户名，下次点一下就回来
        </p>
      </div>
    </div>
  );
}

/** 没填名字时的默认名。只用中间件名：端点已经单列在记录行第二行，名字里再重复一遍只会让一行读两遍同样的地址。 */
function defaultName(config: ConnectionConfig): string {
  return config.kind === "kafka" ? "Kafka" : "RabbitMQ";
}

/** 表单公共的提交区：保存开关。提交按钮在弹窗页脚上。 */
export function SubmitRow({
  save,
  onSaveChange,
}: {
  save: boolean;
  onSaveChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 border-t border-slate-100 pt-3 text-(length:--text-app-meta) text-slate-500">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={save}
        onChange={(event) => onSaveChange(event.currentTarget.checked)}
      />
      <span>
        保存此连接（连同密码写入本机 localStorage）
        <br />
        <span className="text-meta">不勾选则仅在本次运行期间有效</span>
      </span>
    </label>
  );
}

/** 表单共用的默认值，集中在这里避免各表单各自硬编码。 */
export const FORM_DEFAULTS = {
  kafka: {
    brokers: "127.0.0.1:9092",
    mechanism: "none" as SaslMechanism,
    tls: "disabled" as TlsMode,
  },
  rabbitMq: {
    host: "127.0.0.1",
    port: 5672,
    tls: "disabled" as TlsMode,
    username: "guest",
    password: "guest",
    vhost: "/",
  },
};

/** 让 Select 的选项集中在同一处维护。 */
export const TLS_OPTIONS: { value: TlsMode; label: string }[] = [
  { value: "disabled", label: "不启用" },
  { value: "required", label: "强制 TLS" },
];

export const SASL_OPTIONS: { value: SaslMechanism; label: string }[] = [
  { value: "none", label: "无" },
  { value: "plain", label: "PLAIN" },
  { value: "scramSha256", label: "SCRAM-SHA-256" },
  { value: "scramSha512", label: "SCRAM-SHA-512" },
];
