import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  IconClose,
  IconForward,
  IconPlug,
  IconPlus,
  IconServer,
  IconTrash,
} from "@/lib/icons";

import { Button, Card } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import {
  mergeHistory,
  needsSecret,
  previewOf,
  type ConnectionHistoryItem,
} from "@/lib/connection-history";
import { BROKER_LABEL } from "@/lib/nav";
import { reconnectLabel } from "@/lib/reconnect";
import {
  deleteSavedConnection,
  forgetConnection,
  getSavedConnection,
  listRecentConnections,
  listSavedConnections,
  type SavedConnection,
} from "@/lib/session-storage";
import type { BrokerKind, ConnectionConfig, SaslMechanism, TlsMode } from "@/types";

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

/** 一条连接配置 → 人认得出的地址。历史与报错摘要共用同一份措辞。 */
function endpointOf(config: ConnectionConfig): string {
  return config.kind === "kafka"
    ? config.brokers.join(", ")
    : `${config.host}:${config.port}`;
}

/** 首页的历史 = 保存过的记录 + 连成功过的地址（只有名字与地址，没有口令）。 */
function readHistory() {
  const savedList = listSavedConnections();
  const recentList = listRecentConnections();
  return mergeHistory(
    savedList.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.config.kind,
      endpoint: endpointOf(entry.config),
      savedAt: entry.savedAt,
    })),
    recentList,
  );
}

/**
 * 向导当前要连的目标。
 *
 * `kind` 非空 = 用户已经点过某一种中间件（首页卡片、新建行的按钮、记录行的编辑），
 * 弹窗直接进表单；为空只有一种情况 —— 顶栏「＋」，那里没有任何前置选择。
 */
type Target = {
  kind: BrokerKind | null;
  saved?: SavedConnection;
  /** 从「连过 · 未保存」的历史进来时带上地址：参数不在本机，能填的先填上。 */
  endpoint?: string;
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
  /**
   * 「连过」的历史：保存过的记录 + 没保存但连成功过的地址。
   *
   * 以前这一页只认 `saved-connections`，没勾「保存此连接」的人连成功之后
   * 首页什么都不会留下 —— 界面上那句「连过一次之后会留在这里」就成了空头承诺。
   * 现在两份本地数据合成一条时间线，空态也把最近连过的几台摆出来。
   */
  const [history, setHistory] = useState(() => readHistory());
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
    // 删记录只删「保存过的配置」，`recent-connections` 里那台机器还在 —— 两者是
    // 两件事（「存了参数」vs「连过」），所以首页上它会退回成一条不可重连的历史。
    deleteSavedConnection(entry.id);
    setSaved(listSavedConnections());
    setHistory(readHistory());
  }, []);

  /** 从历史里删掉一条「只是连过」的地址：它没有配置可删，删的是这条记忆。 */
  const forgetRecent = useCallback((kind: BrokerKind, endpoint: string) => {
    forgetConnection({ kind, endpoint });
    setHistory(readHistory());
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

  /**
   * 版面分界看的是「有没有历史」，不只是「有没有保存过的记录」。
   *
   * 以前这里判 `saved.length`：没勾保存的人连过一次之后首页照旧是「开始使用」，
   * 连成功这件事在界面上完全没发生。现在只要留下过痕迹（保存的或连过的），
   * 这一页就换成记录形态 —— 名字在前、入口在后。
   */
  const hasHistory = history.length > 0;
  const savedCount = saved.length;
  /**
   * 记录形态里，保存过的记录用完整行，只是连过的收成一列小行。
   *
   * 一条都没保存时，上面那截是空的，于是这一段就充当主体 —— 这时候按预览上限
   * 只摆三条，再往下才是新建入口，免得历史把「怎么连」压到屏幕外面。
   */
  const unsavedHistory = history.filter((item) => item.savedId === null);
  const shownUnsaved = savedCount > 0 ? unsavedHistory : previewOf(unsavedHistory);
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
        {hasHistory ? (
          <>
            {/* ui-lint-allow: 首页展示级标题 */}
            <h1 className="text-[28px] leading-9 font-semibold tracking-tight text-slate-900">
              连接记录
            </h1>
            <p className="mt-2 text-(length:--text-app-body) leading-relaxed text-slate-500">
              点「重连」直接接回去；换地址或口令走「编辑连接」
            </p>

            {savedCount > 0 ? (
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
            ) : null}

            {/* 「连过但没保存」的机器：参数不在本机，所以给不了「重连」，
                只把地址带进向导。它们排在能重连的记录之后，用更轻的行高。 */}
            {shownUnsaved.length > 0 ? (
              <section className={savedCount > 0 ? "mt-7" : "mt-6"}>
                <p className="flex items-baseline gap-2 text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase">
                  <span>连过 · 未保存</span>
                  <span className="font-normal normal-case text-meta">
                    参数不在本机，点一下重填地址
                  </span>
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {shownUnsaved.map((item) => (
                    <li key={item.key}>
                      <RecentRow
                        item={item}
                        onResume={() =>
                          setTarget({ kind: item.kind as BrokerKind, endpoint: item.endpoint })
                        }
                        onForget={() => forgetRecent(item.kind as BrokerKind, item.endpoint)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

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

            {/* 空态不等于白纸：连过但没勾「保存」的机器会走上面那段记录形态，
                点一下把地址带回向导。这里只剩「为什么上面什么都没有」这一句。 */}
            <p className="mt-4 text-(length:--text-app-meta) leading-relaxed text-meta">
              勾选「保存此连接」才会留下可一键重连的记录；只连不保存的机器会留在「连过 · 未保存」里。
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
          initialEndpoint={target.endpoint ?? null}
          onClose={() => {
            closeWizard();
            // 关掉向导时重读两份本地数据：勾了保存就多一条记录，没勾也会多一条
            // 「连过」的历史（`open_connection` 成功时写的 recent）。
            setSaved(listSavedConnections());
            setHistory(readHistory());
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
      <IconPlus className="size-4 shrink-0 text-meta" />
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
        <IconServer className="size-6" />
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
      <IconForward className="size-4 shrink-0 text-meta transition-colors group-hover:text-indigo-600" />
    </button>
  );
}

/**
 * 一条「连过但没保存」的历史。
 *
 * 这一行不能提供「重连」：`recent-connections` 里只有名字与地址，口令没落盘
 * （用户当初没勾保存），点下去必定失败 —— 与其给一个会报错的按钮，不如把
 * 地址带进向导，人只需要补口令。
 */
function RecentRow({
  item,
  onResume,
  onForget,
}: {
  item: ConnectionHistoryItem;
  onResume: () => void;
  onForget: () => void;
}) {
  const kind = item.kind as BrokerKind;
  return (
    <div className="group/row flex items-center gap-3 rounded-xl bg-white/60 px-3 py-2 ring-1 ring-slate-200/70 transition-colors hover:bg-white hover:ring-slate-300">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          kind === "kafka" ? "bg-amber-50 text-broker-kafka" : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <IconPlug className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 truncate text-(length:--text-app-meta) font-medium text-slate-800">
          <span className="truncate">{item.name}</span>
          <span className="shrink-0 text-(length:--text-app-micro) font-normal text-meta">
            {BROKER_LABEL[kind] ?? item.kind}
          </span>
        </p>
        <p className="truncate font-mono text-(length:--text-app-micro) text-meta">{item.endpoint}</p>
      </div>
      <Button size="sm" variant="ghost" onClick={onResume} title={`重新填写 ${item.name} 的连接信息`}>
        重新连接…
      </Button>
      <button
        type="button"
        onClick={onForget}
        aria-label={`从历史里移除 ${item.name}`}
        title={`从历史里移除 ${item.name}`}
        className="shrink-0 rounded-md p-1.5 text-meta opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-rose-50 hover:text-rose-600 group-focus-within/row:opacity-100"
      >
        <IconTrash className="size-3.5" />
      </button>
    </div>
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
  // 判据放在 `lib/connection-history.ts`：它同时决定这条记录算不算「能重连」。
  const missingSecret = needsSecret(entry);

  return (
    <Card className="flex items-center gap-3.5 px-4 py-3 transition-colors hover:ring-slate-300">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          config.kind === "kafka" ? "bg-amber-50 text-broker-kafka" : "bg-violet-50 text-broker-rabbitmq",
        )}
      >
        <IconPlug className="size-4" />
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
        <IconTrash className="size-3.5" />
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
        {/*
          这里原来写的是「不勾选则仅在本次运行期间有效」—— 那句话还带着旧语义：
          早期确实只有保存过的连接才会出现在首页，没勾的人连成功也什么都不剩。
          现在连成功会留下一条「连过」的历史（只有名字与地址），文案必须跟着改，
          否则用户会以为不勾就等于白连一次。
        */}
        <span className="text-meta">
          不勾选也能连，只是不留口令：下次从「连过 · 未保存」里点回来重填即可
        </span>
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
