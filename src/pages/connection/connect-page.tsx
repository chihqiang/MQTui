import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Plug, Plus, Server, Trash2 } from "lucide-react";

import { IconClose } from "@/lib/icons";

import { Button, Card } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { BROKER_LABEL } from "@/lib/nav";
import { canReconnect, reconnectLabel } from "@/lib/reconnect";
import {
  deleteSavedConnection,
  getSavedConnection,
  listSavedConnections,
  type SavedConnection,
} from "@/lib/session-storage";
import type { BrokerKind, SaslMechanism, TlsMode } from "@/types";

import { ConnectWizard } from "./connect-wizard";

/**
 * 首页：一条记录都没有时问「连哪种」，有记录时先摆记录。
 *
 * 这一页上的每一次点击都已经回答了「连哪种」—— 卡片、新建行的小按钮、
 * 记录行的编辑，点时就知道要 Kafka 还是 RabbitMQ。所以弹窗进来就是填参数，
 * 不再把同一个问题问第二遍。只有顶栏「＋」没有前置选择，才从第一步问起。
 *
 * 形态上刻意**不**做「连接记录 / 新建连接」两个页签：
 *
 * - 页签把「选类型」和「填参数」摊在同一屏，选 Kafka 之后表单就等在旁边，
 *   用户得先看懂这一页有几块内容，才知道从哪开始；
 * - 而选中间件本质上只有两三个选项，是一次选择、不是一段状态。
 *
 * 两套版面的分界是 `saved.length`：空的时候这一页的任务是「教会你连一个」，
 * 有记录之后任务是「把上次那台接回来」。所以有记录时标题、顺序都跟着换 ——
 * 记录在最上面，新建收成一行。让每天要点的东西排在一年点两次的东西后面，
 * 是这一页最早犯的错。
 *
 * 顶栏的「＋」走的是同一个向导（`/?new=1`），但它比首页的入口多一步：
 * 这里每张卡都带着类型，那里什么都没带。
 */

/** 每种中间件一句人话 + 默认端口。文案属于界面，不进后端清单。 */
const KIND_HINT: Record<BrokerKind, { summary: string; port: string }> = {
  kafka: { summary: "主题、分区、消费组与位点", port: "9092" },
  rabbitMq: { summary: "队列、交换机、绑定与消息处置", port: "15672（管理 API）" },
};

/**
 * 向导当前要连的目标。
 *
 * `kind` 非空 = 用户已经点过某一种中间件（首页卡片、新建行的按钮、记录行的编辑），
 * 弹窗直接进表单；为空只有一种情况 —— 顶栏「＋」，那里没有任何前置选择。
 */
type Target = {
  kind: BrokerKind | null;
  saved?: SavedConnection;
};

export function ConnectPage() {
  const { data: plugins } = usePluginKinds();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [target, setTarget] = useState<Target | null>(null);
  /**
   * 顶栏「＋」是唯一一个「跳转 + 立刻弹窗」的入口：页面会在脚下换掉，
   * 再盖一层弹窗，用户很容易以为刚才那下点空了。这里留一条可关闭的提示，
   * 把「你现在停在哪一步」写出来。
   */
  const [justArrived, setJustArrived] = useState(false);
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

  const closeWizard = useCallback(() => setTarget(null), []);

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
    setJustArrived(false);
    setTarget({ kind: entry.config.kind, saved: entry });
  }, []);

  const removeSaved = useCallback((entry: SavedConnection) => {
    deleteSavedConnection(entry.id);
    setSaved(listSavedConnections());
  }, []);

  /**
   * `?new=1` 是顶栏「＋」的入口：它落在首页而不是弹一个独立弹窗，
   * 这样从任何页面点「＋」都会回到同一处，关掉向导也不会把用户留在空页面上。
   */
  const wantsNew = searchParams.get("new") === "1";
  useEffect(() => {
    if (!wantsNew) return;
    setSearchParams({}, { replace: true });
    setTarget({ kind: null });
    setJustArrived(true);
  }, [wantsNew, setSearchParams]);

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

  const hasSaved = saved.length > 0;
  const pluginList = useMemo(
    () => plugins ?? [{ kind: "kafka" as BrokerKind, displayName: "Kafka", capabilities: [] }],
    [plugins],
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        {/* 从别的页面点「＋」进来时说明一句。它只在本次跳转后出现，
            刷新或手动关掉都不会再来 —— 常态页面不该常驻一条指南。 */}
        {justArrived ? (
          <div
            role="status"
            className="animate-fade-in mb-6 flex items-start gap-2.5 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-(length:--text-app-meta) text-slate-600"
          >
            <span className="min-w-0 flex-1 leading-relaxed">
              已打开新建向导：<span className="font-medium text-slate-800">先选中间件</span>，再填连接地址与凭据。
            </span>
            <button
              type="button"
              onClick={() => setJustArrived(false)}
              aria-label="关闭提示"
              className="shrink-0 rounded p-0.5 text-meta transition-colors hover:text-slate-900"
            >
              <IconClose size={12} />
            </button>
          </div>
        ) : null}
        {/* 有记录之后，这一页的主角是记录：每天要点的是它，选中间件一辈子点几次。
            所以标题、顺序、视觉重量都跟着状态换一次，而不是让「开始使用」常驻在最上面。 */}
        {hasSaved ? (
          <>
            {/* ui-lint-allow: 首页展示级标题 */}
            <h1 className="text-[28px] leading-9 font-semibold tracking-tight text-slate-900">
              连接记录
            </h1>
            <p className="mt-2 text-(length:--text-app-body) leading-relaxed text-slate-500">
              点「重连」直接接回去；换地址或口令走「编辑连接」
            </p>

            <ul className="mt-6 flex flex-col gap-2.5">
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

            <NewConnectionRow
              kinds={pluginList}
              onPick={(kind) => {
                setJustArrived(false);
                setTarget({ kind });
              }}
            />
          </>
        ) : (
          <>
            {/* 全屏只有这一处内容，所以标题单独走一档 28px 的展示级 —— 五档语义阶梯
                同时要服务 30 行的表格，压不下这个尺寸。 */}
            {/* ui-lint-allow: 首页空态展示级标题 */}
            <h1 className="text-[28px] leading-9 font-semibold tracking-tight text-slate-900">
              开始使用
            </h1>
            <p className="mt-2 text-(length:--text-app-body) leading-relaxed text-slate-500">
              选择要连接的中间件，下一步填连接信息
            </p>

            {/* 两张卡之间留 12px 而不是 8px：这是全屏唯一的内容，卡片太挤会显得
                整个首页像一张没写完的表单。 */}
            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              {pluginList.map((plugin) => (
                <KindCard
                  key={plugin.kind}
                  kind={plugin.kind}
                  displayName={plugin.displayName}
                  onPick={() => {
                    setJustArrived(false);
                    setTarget({ kind: plugin.kind });
                  }}
                />
              ))}
            </div>

            <p className="mt-4 text-(length:--text-app-meta) text-meta">
              连过一次之后会留在这里，下次点一下就回来
            </p>
          </>
        )}
      </div>

      {/* 向导自己管步骤；这里只在关掉时刷新记录列表 —— 勾了「保存」之后，
          首页下方那一段应该立刻多一条。 */}
      {target ? (
        <ConnectWizard
          open
          initialKind={target.kind}
          initialSaved={target.saved ?? null}
          onClose={() => {
            closeWizard();
            setSaved(listSavedConnections());
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 有记录时，「新建」收成一行。
 *
 * 之前两块都是卡片：上面两张选类型的大卡、下面一列记录。等记录攒到五条，
 * 每天要点的东西被两张每年点一次的卡挤到了下面 —— 层级是按「第一次使用」排的。
 * 现在新建只用一行说明 + 两个小按钮，位置在记录之后，点完还是同一个向导。
 */
function NewConnectionRow({
  kinds,
  onPick,
}: {
  kinds: { kind: BrokerKind; displayName: string }[];
  onPick: (kind: BrokerKind) => void;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-3">
      <Plus className="size-4 shrink-0 text-meta" />
      <span className="text-(length:--text-app-meta) text-secondary">新建连接</span>
      {kinds.map((item) => (
        <Button key={item.kind} size="sm" variant="ghost" onClick={() => onPick(item.kind)}>
          {item.displayName}
        </Button>
      ))}
      <span className="ml-auto text-(length:--text-app-micro) text-meta">
        也可以按顶部「＋」，从第一步选起
      </span>
    </div>
  );
}

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
        "group flex items-center gap-4 rounded-2xl bg-white p-5 text-left shadow-xs transition-all duration-(--motion-base)",
        "ring-1 ring-slate-200/80 hover:-translate-y-0.5 hover:shadow-md hover:ring-indigo-300",
      )}
    >
      <span
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-xl",
          kind === "kafka" ? "bg-amber-50 text-broker-kafka" : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <Server className="size-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-(length:--text-app-title) font-semibold text-slate-900">
            {displayName}
          </span>
          <span className="text-(length:--text-app-micro) text-meta">端口 {hint.port}</span>
        </span>
        <span className="mt-1 block truncate text-(length:--text-app-meta) text-meta">
          {hint.summary}
        </span>
      </span>
      {/* 箭头只在悬停时上色：两张大白卡常驻一个主色按钮，会把「选一个」变成「点按钮」。 */}
      <ArrowRight className="size-4 shrink-0 text-meta transition-colors group-hover:text-indigo-600" />
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
  // 判据放在 `lib/reconnect.ts`：命令面板里的「重连」读的是同一份规则。
  const missingSecret = !canReconnect(entry);

  return (
    <Card className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:ring-slate-300">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          config.kind === "kafka" ? "bg-amber-50 text-broker-kafka" : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <Plug className="size-4" />
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
        <p className="mt-0.5 truncate font-mono text-(length:--text-app-meta) text-meta">{endpoint}</p>
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
        title={busy ? `正在连接 ${entry.name}` : `重新连接 ${entry.name}`}
      >
        {reconnectLabel(entry.name, busy)}
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
