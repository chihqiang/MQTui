import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { ArrowRight, Plug, Server, Trash2 } from "lucide-react";

import { Button, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
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
 * 首页：连接记录 + 新建连接。
 *
 * 形态参考主流桌面管理面板，而不是「一张空表单摆在页面正中」：
 *
 * - **连过的环境**一行一台，地址与用户名都写在行上，点「重连」直接接回去，
 *   不经过表单、不用重填任何字段；
 * - **新建连接**先选中间件类型（点卡片），再填该类型的参数。
 *
 * 这样第一次打开的人和每天都打开的人看到的是同一个入口，只是默认落在不同的页签上。
 */

/** 每种中间件一句人话 + 管理端口提示。文案属于界面，不进后端清单。 */
const KIND_HINT: Record<BrokerKind, { summary: string; port: string }> = {
  kafka: { summary: "主题、分区、消费组与位点", port: "9092" },
  rabbitMq: { summary: "队列、交换机、绑定与消息处置", port: "15672（管理 API）" },
};

type TabKey = "saved" | "new";

export function ConnectPage() {
  const { data: plugins } = usePluginKinds();
  const [kind, setKind] = useState<BrokerKind>("kafka");
  const [name, setName] = useState("");
  const [save, setSave] = useState(false);
  // 已保存列表是 localStorage 而非服务端数据，用一次读取 + 手动刷新保持简单。
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  // 「填入表单」要预填的那一条。null 表示当前表单是从草稿起来的。
  const [prefill, setPrefill] = useState<SavedConnection | null>(null);
  const openConnection = useOpenConnection();
  const [searchParams, setSearchParams] = useSearchParams();

  /*
   * 有记录时默认落在「连接记录」：那才是回来这里想干的事。
   * 惰性初始化而不是 effect 里切 —— 先渲染成表单再切过去会闪一下。
   */
  const [tab, setTab] = useState<TabKey>(() =>
    listSavedConnections().length > 0 ? "saved" : "new",
  );

  const submit = (config: ConnectionConfig) => {
    openConnection.mutate(
      { name: name || defaultName(config), config, save },
      {
        onSuccess: () => {
          // 连上了就说明配置有效，草稿没用了，清掉免得下次残留半成品。
          clearDraft(config.kind);
          setPrefill(null);
          setSaved(listSavedConnections());
        },
      },
    );
  };

  /** 记录行上的「重连」：直接连，不打开表单。 */
  const reconnect = useCallback(
    (entry: SavedConnection) => {
      setKind(entry.config.kind);
      setName(entry.name);
      openConnection.mutate({ name: entry.name, config: entry.config });
    },
    [openConnection],
  );

  /**
   * 正在连的那一条。
   *
   * `openConnection` 是全局一个 mutation，把 `isPending` 直接传给每一行，
   * 点击时全部十条记录一起转圈 —— 看不出到底在连哪台。这里记住被点的那条。
   */
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    if (!openConnection.isPending) setPendingId(null);
  }, [openConnection.isPending]);

  /**
   * 记录行上的「填入表单」：缺密码、想改端口时走这条路。
   *
   * 必须真把配置摊进表单 —— 以前只切了页签，表单还停在上一次的草稿上，
   * 点了和没点一样，用户只能自己重打一遍地址。
   */
  const fillForm = useCallback((entry: SavedConnection) => {
    setKind(entry.config.kind);
    setName(entry.name);
    setPrefill(entry);
    setTab("new");
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
    openConnection.mutate({ name: pendingResume.name, config: pendingResume.config });
  }, [pendingResume, openConnection, setSearchParams]);

  const pluginList = useMemo(
    () => plugins ?? [{ kind: "kafka" as BrokerKind, displayName: "Kafka", capabilities: [] }],
    [plugins],
  );

  return (
    <div className="h-full overflow-auto">
      {/* 表单页用 2xl 而不是 3xl：浅色主题下 768px 宽的空表单会让「名字」和「地址」
          隔着半个屏幕，眼睛要在两行之间来回跑。 */}
      <div className="mx-auto w-full max-w-2xl px-6 py-7">
        <h1 className="text-(length:--text-app-display) font-semibold tracking-tight text-slate-900">
          开始使用
        </h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {saved.length > 0
            ? `连过的 ${saved.length} 个环境都还在，点「重连」直接接回来，不用重填地址`
            : "还没有连接记录。挑一种中间件连上，就能开始管理主题、队列与消息"}
        </p>

        {/* 页签：一条细下划线，选中项用主色描边 —— 比两个大按钮轻，也比下拉省一次点击。 */}
        <div
          role="tablist"
          aria-label="连接入口"
          className="mt-5 mb-3 flex items-center gap-1 border-b border-slate-200"
        >
          <TabButton
            active={tab === "saved"}
            label="连接记录"
            count={saved.length}
            onClick={() => setTab("saved")}
          />
          <TabButton active={tab === "new"} label="新建连接" onClick={() => setTab("new")} />
        </div>

        {tab === "saved" ? (
          saved.length === 0 ? (
            <EmptySaved onCreate={() => setTab("new")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {saved.map((entry) => (
                <li key={entry.id}>
                  <SavedRow
                    entry={entry}
                    busy={pendingId === entry.id}
                    onReconnect={() => {
                      setPendingId(entry.id);
                      reconnect(entry);
                    }}
                    onFill={() => fillForm(entry)}
                    onRemove={() => removeSaved(entry)}
                  />
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader
                title="选择中间件"
                extra={
                  <span className="text-(length:--text-app-micro) text-meta">
                    类型清单由后端下发
                  </span>
                }
              />
              <CardBody className="grid gap-2 sm:grid-cols-2">
                {pluginList.map((plugin) => (
                  <KindCard
                    key={plugin.kind}
                    kind={plugin.kind}
                    displayName={plugin.displayName}
                    active={plugin.kind === kind}
                    onPick={() => setKind(plugin.kind)}
                  />
                ))}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="连接信息"
                extra={
                  <span className="text-(length:--text-app-micro) text-meta">
                    {BROKER_LABEL[kind]}
                  </span>
                }
              />
              <CardBody className="flex flex-col gap-4">
                <Field label="连接名称（可选）" hint="同名同类型会覆盖已保存的连接">
                  <Input
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder={kind === "kafka" ? "例如：本地 Kafka" : "例如：本地 RabbitMQ"}
                  />
                </Field>

                {kind === "kafka" ? (
                  <ConnectionFormKafka
                    submitting={openConnection.isPending}
                    onSubmit={submit}
                    save={save}
                    onSaveChange={setSave}
                    initialConfig={
                      prefill?.config.kind === "kafka" ? prefill.config : null
                    }
                  />
                ) : (
                  <ConnectionFormRabbitMq
                    submitting={openConnection.isPending}
                    onSubmit={submit}
                    save={save}
                    onSaveChange={setSave}
                    initialConfig={
                      prefill?.config.kind === "rabbitMq" ? prefill.config : null
                    }
                  />
                )}
              </CardBody>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // 选中项靠 2px 主色下划线 + 深一档的字重说话，不再叠半透明底：
        // 一段 24px 高的淡靛蓝方块比线更抢眼，而它表达的只是「当前页签」。
        "-mb-px border-b-2 px-3 py-2 text-xs transition-colors",
        active
          ? "border-indigo-600 font-semibold text-slate-900"
          : "border-transparent font-medium text-slate-500 hover:text-slate-800",
      )}
    >
      {label}
      {count !== undefined ? (
        <span
          className={cn(
            "ml-1.5 rounded px-1 py-0.5 text-(length:--text-app-micro)",
            active ? "bg-indigo-50 text-indigo-600" : "bg-slate-100 text-slate-500",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** 一张中间件卡片：整张可点，选中态用主色描边而不是换底色。 */
function KindCard({
  kind,
  displayName,
  active,
  onPick,
}: {
  kind: BrokerKind;
  displayName: string;
  active: boolean;
  onPick: () => void;
}) {
  const hint = KIND_HINT[kind] ?? { summary: "", port: "" };
  return (
    <button
      type="button"
      data-kind={kind}
      onClick={onPick}
      aria-pressed={active}
      className={cn(
        "group flex items-start gap-3 rounded-xl p-3 text-left transition-colors",
        // 选中用「实线主色描边 + 白底 + 主色图标块」，未选中用中性描边。
        // 选中态不再半透明铺底：浅色主题里那层 60% 的靛蓝落在白卡上会发灰。
        active
          ? "bg-white ring-1 ring-indigo-500"
          : "bg-white ring-1 ring-slate-200 hover:ring-slate-300",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500",
        )}
      >
        <Server className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-slate-900">{displayName}</span>
          <span className="text-(length:--text-app-micro) text-meta">
            端口 {hint.port}
          </span>
        </span>
        <span className="mt-0.5 block text-(length:--text-app-meta) leading-relaxed text-slate-500">
          {hint.summary}
        </span>
      </span>
    </button>
  );
}

/** 一条连接记录。地址、用户名、是否存了密码都在行上，不用点开才知道。 */
function SavedRow({
  entry,
  busy,
  onReconnect,
  onFill,
  onRemove,
}: {
  entry: SavedConnection;
  busy: boolean;
  onReconnect: () => void;
  onFill: () => void;
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
          config.kind === "kafka"
            ? "bg-amber-50 text-broker-kafka"
            : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <Plug className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* 第一行：名字 + 类型 + 用户；第二个行：端点。信息分两层，扫读先认名字。 */}
        <p className="flex items-baseline gap-2 truncate text-xs font-medium text-slate-900">
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
      <Button size="sm" variant="ghost" onClick={onFill}>
        {missingSecret ? "补口令" : "填入表单"}
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

function EmptySaved({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-slate-100 text-meta">
        <Plug className="size-5" />
      </span>
      <div>
        <p className="text-xs font-medium text-slate-600">还没有连过的环境</p>
        <p className="mt-1 text-(length:--text-app-meta) text-meta">
          连上一次之后，这里会留下地址与用户名，下次点一下就回来
        </p>
      </div>
      <Button size="sm" icon={<ArrowRight className="size-3.5" />} onClick={onCreate}>
        新建连接
      </Button>
    </div>
  );
}

function defaultName(config: ConnectionConfig): string {
  return config.kind === "kafka"
    ? `Kafka ${config.brokers[0] ?? ""}`.trim()
    : `RabbitMQ ${config.host}:${config.port}`;
}

/** 表单公共的提交区：保存开关 + 提交按钮。 */
export function SubmitRow({
  submitting,
  label,
  save,
  onSaveChange,
}: {
  submitting: boolean;
  label: string;
  save: boolean;
  onSaveChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
      <label className="flex items-start gap-2 text-(length:--text-app-meta) text-slate-500">
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
      <Button type="submit" loading={submitting}>
        {label}
      </Button>
    </div>
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
