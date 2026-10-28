import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  IconClose,
  IconForward,
  IconPlug,
  IconPlus,
  IconRepeat,
  IconServer,
  IconTrash,
} from "@/lib/icons";

import { Badge, Button, Card, ConfirmDialog, Field, Input, Modal } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import {
  canReconnect,
  displayName,
  previewOf,
  secretLabelOf,
  secretStateOf,
} from "@/lib/connection-history";
import { brokerMetaOf } from "@/lib/connection-defaults";
import { configForHistory, historyOf, toneClass } from "@/lib/connect-form";
import { removalOf } from "@/lib/connection-history";
import { BROKER_LABEL, brokerIcon } from "@/lib/nav";
import { reconnectLabel } from "@/lib/reconnect";
import { brokerTone } from "@/lib/visual";
import {
  deleteSavedConnection,
  forgetConnection,
  getSavedConnection,
  listSavedConnections,
  readDraft,
} from "@/lib/session-storage";
import type { BrokerKind } from "@/types";
import type { ConnectionHistoryItem } from "@/lib/connection-history";
import type { SavedConnection } from "@/lib/session-storage";
import { UNSAVED_FORM_ID, type ConnectTarget } from "@/types/connection";

import { ConnectWizard } from "@/components/broker/connect-wizard";

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

export function ConnectPage() {
  const { data: plugins } = usePluginKinds();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [target, setConnectTarget] = useState<ConnectTarget | null>(null);
  /**
   * 「连过 · 未保存」那一行点下去先问一句要去哪：去填参数（带上地址），
   * 还是就地再试一次（主机/端口/账号都还记得，缺的只有口令）。
   *
   * 直接弹表单会显得「点重连」被改成了「重填」；直接连又必定因为缺口令失败。
   * 这两种都是猜测，不如把两个动作摊开、说清各自要补什么。
   */
  const [ask, setAsk] = useState<ConnectionHistoryItem | null>(null);
  /**
   * 待确认删除的那一行。
   *
   * 这张表里每隔几十像素就有一个「删除」，而它旁边常亮的是「重连」——
   * 点偏一格就把一台机器的参数弄丢了，下次只能重新填一遍。
   * 所以删除先问一句「删的是哪台」，确认了再动手。
   */
  const [removing, setRemoving] = useState<ConnectionHistoryItem | null>(null);
  /**
   * 顶栏「＋」是唯一一个「跳转 + 立刻弹窗」的入口：页面会在脚下换掉，
   * 再盖一层弹窗，用户很容易以为刚才那下点空了。这里留一条可关闭的提示，
   * 把「你现在停在哪一步」写出来。
   */
  const [justArrived, setJustArrived] = useState(false);
  /**
   * 首页那张列表：保存过的记录 + 连成功过的地址，一条时间线。
   *
   * 只有这一份状态 —— 以前这里同时存着 `saved` 和 `history` 两个数组，
   * 界面上也就跟着长成了「已保存」/「连过 · 未保存」两段。可它们差的只是
   * 一个布尔（口令在不在本机），分成两段等于让「我有没有勾保存」去决定
   * 这台机器算不算我的。现在合成一张表，标记留在行上。
   */
  const [history, setHistory] = useState(() => historyOf(listSavedConnections()));
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

  const closeWizard = useCallback(() => setConnectTarget(null), []);

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
    setConnectTarget({ kind: entry.config.kind, saved: entry });
  }, []);

  /**
   * 「就连这一次」：历史里记得主机、端口、账号，唯独没有口令 —— 补上口令再连，
   * 不做任何落盘（这条记录的语义就是「参数不在本机」，别偷偷替人改成保存）。
   */
  const connectOnce = useCallback(
    (item: ConnectionHistoryItem, credential: { username: string; password: string }) => {
      const config = configForHistory(item, credential);
      openConnection.mutate(
        { name: displayName(item) || BROKER_LABEL[item.kind as BrokerKind], config },
        { onSuccess: (summary) => navigate(`/connections/${summary.id}`) },
      );
    },
    [navigate, openConnection],
  );

  /**
   * 不用口令的那一行「连接一次」：一格里都不用填，直接按草稿再连一次。
   *
   * 和 `connectOnce` 走同一份配置拼装，只是没有账号口令可填 ——
   * 这一类行之所以走到弹窗，是因为「连过但没保存」，不是因为它缺东西。
   */
  const reconnectUnsaved = useCallback(
    (item: ConnectionHistoryItem) => connectOnce(item, { username: "", password: "" }),
    [connectOnce],
  );

  /**
   * 行上的删除按钮：一条路走到底 —— 删掉的就是这一行，不是这个名字。
   *
   * 以前这里只删 `saved-connections`，`recent-connections` 里那台机器还在，
   * 于是点了删除，行没消失、只是退回成「缺口令」的样子，看着像没删掉。
   *
   * 这一行背后可能是「保存过的记录」「连过的地址」或者两者都有（合并成一行），
   * 点删除都只该少这一行。所以按 `removalOf` 给出的清单逐项清，而不是让
   * 调用点去猜该删哪一样 —— 猜错的那一次，就是「点一个、删了一片」。
   */
  const removeEntry = useCallback((item: ConnectionHistoryItem) => {
    const removal = removalOf(item);
    if (removal.savedId) deleteSavedConnection(removal.savedId);
    if (removal.recent) forgetConnection(removal.recent);
    setHistory(historyOf(listSavedConnections()));
    setRemoving(null);
  }, []);

  /**
   * `?new=1` 是顶栏「＋」的入口：它落在首页而不是弹一个独立弹窗，
   * 这样从任何页面点「＋」都会回到同一处，关掉向导也不会把用户留在空页面上。
   */
  const wantsNew = searchParams.get("new") === "1";
  useEffect(() => {
    if (!wantsNew) return;
    setSearchParams({}, { replace: true });
    setConnectTarget({ kind: null });
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
  /**
   * 一条能直接重连的都没有时，这张表就从「我常连的东西」降格成「我碰过的东西」——
   * 只摆头三条，再往下是新建入口。全都缺口令的时候还整页列六条，
   * 相当于拿一份点不动的名单占满第一屏。
   */
  const reconnects = history.filter(canReconnect);
  const shown = reconnects.length > 0 ? history : previewOf(history);
  const restCount = history.length - shown.length;
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
            <h1 className="text-[28px] leading-9 font-semibold tracking-tight text-slate-900">
              连接记录
            </h1>
            <p className="mt-2 text-(length:--text-app-body) leading-relaxed text-slate-500">
              点「重连」直接回去；标着「口令不在本机」的那几条，点开补一次口令。没标的就是不用口令。
            </p>

            {/* 一张表，不分段。
                以前这里上下切成「连接记录」和「连过 · 未保存」两块 —— 差别只是口令
                存没存下来，却让「我有没有勾那个勾选框」去决定这台机器算不算我的。
                现在顺序和行高统一，区别收进行内一枚标记。 */}
            <ul className="mt-6 flex flex-col gap-2.5">
              {shown.map((item) => {
                const entry = item.savedId ? getSavedConnection(item.savedId) : null;
                return (
                  <li key={item.key}>
                    <HistoryRow
                      item={item}
                      entry={entry}
                      labels={pluginList.map((plugin) => plugin.displayName)}
                      busy={entry ? pendingId === entry.id : false}
                      openBusy={entry ? false : openConnection.isPending}
                      onReconnect={() => entry && reconnect(entry)}
                      onEdit={() => entry && editSaved(entry)}
                      onOpen={() => setAsk(item)}
                      onRemove={() => setRemoving(item)}
                    />
                  </li>
                );
              })}
            </ul>
            {restCount > 0 ? (
              <p className="mt-2.5 text-(length:--text-app-micro) text-meta">
                还有 {restCount} 条更早的记录，连上之后会排到前面来。
              </p>
            ) : null}

            <NewConnectionRow
              kinds={pluginList}
              onPick={(kind) => {
                setJustArrived(false);
                setConnectTarget({ kind });
              }}
            />
          </>
        ) : (
          <>
            {/* 全屏只有这一处内容，所以标题单独走一档 28px 的展示级 —— 五档语义阶梯
                同时要服务 30 行的表格，压不下这个尺寸。 */}
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
                    setConnectTarget({ kind: plugin.kind });
                  }}
                />
              ))}
            </div>

            {/* 空态不等于白纸，但也不该先教一遍「保存」的规则。
                这里只回答「连过之后这页会变成什么样」，勾选框的含义留在勾选框旁边。 */}
            <p className="mt-4 text-(length:--text-app-meta) leading-relaxed text-meta">
              连过一次就会出现在这里。勾了「保存此连接」的是点一下就回去，没勾的补一次口令也能连。
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
            setHistory(historyOf(listSavedConnections()));
          }}
        />
      ) : null}

      {/* 缺口令那一行点开后的小弹窗：就地补个口令接一次，或者去填全部参数。
          两个动作都写清各自要补什么 —— 前者只缺口令，后者还能改 TLS / SASL / vhost。 */}
      {/* 删除前问一句。文案只回答一件事：删的是哪台、删完还剩什么 ——
          「配置留在本机」和「这台机器上的数据」不是一回事，别让人以为删记录等于删了集群。 */}
      <ConfirmDialog
        open={removing !== null}
        title="从连接记录里删除"
        danger
        confirmLabel="删除记录"
        description={
          removing ? (
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-(length:--text-app-meta) break-all text-slate-700">
                {removing.endpoint}
              </span>
              <span>
                删掉的是本机这条记录（名字、地址与存下的口令）。只影响这一个连接，
                其他记录不动；已经打开的那条会话也不受影响。
              </span>
            </div>
          ) : null
        }
        onConfirm={() => removing && removeEntry(removing)}
        onClose={() => setRemoving(null)}
      />

      {ask ? (
        <UnsavedConnectionDialog
          item={ask}
          labels={pluginList.map((plugin) => plugin.displayName)}
          busy={openConnection.isPending}
          onFill={() => {
            setAsk(null);
            setConnectTarget({ kind: ask.kind as BrokerKind, endpoint: ask.endpoint });
          }}
          onDirect={() => reconnectUnsaved(ask)}
          onConnect={(credential) => connectOnce(ask, credential)}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 缺口令那一行点开后的选择。
 *
 * 为什么要有这个弹窗：那一行的口令不在本机，直接给「重连」必定失败；
 * 只给「去填参数」又等于把「连接」改叫成「重填」。所以拆成两条路，说清各自补什么：
 * 想留成记录就去填参数；只是现在要连一次就只补口令。
 *
 * 两条路都不写「记住口令」—— 这一行的语义就是「口令不在本机」，
 * 真觉得该记住的时刻是填完表单勾「保存此连接」。
 */
function UnsavedConnectionDialog({
  item,
  labels,
  busy,
  onDirect,
  onFill,
  onConnect,
  onClose,
}: {
  item: ConnectionHistoryItem;
  labels: readonly string[];
  busy: boolean;
  /** 这台机器不用口令：直接照草稿重连一次，什么都不用填。 */
  onDirect: () => void;
  /** 带上地址去填参数（TLS、SASL、vhost 这些都在那一步）。 */
  onFill: () => void;
  /** 就地补口令再连一次，不留记录。 */
  onConnect: (credential: { username: string; password: string }) => void;
  onClose: () => void;
}) {
  const kind = item.kind as BrokerKind;
  const name = displayName(item, labels);
  /**
   * 这一行用不上口令。
   *
   * 「没存口令」和「不用口令」长得一样，含义正相反。前者要人补一次，
   * 后者再问就是纯干扰 —— 这台机器当初就是明文直连的。
   */
  const noAuth = item.noAuth;
  /**
   * 账号：历史里没存过它，但表单草稿里可能还留着上一次填的那一份。
   * 这份草稿是同一台机器上的同一份表单记忆，用它预填不算编造。
   */
  const draft = readDraft(kind);
  const draftUser = draft?.auth?.username ?? "";
  const [username, setUsername] = useState(draftUser);
  const [password, setPassword] = useState("");
  const needsUser = draftUser.trim() === "";

  // 不用口令的那一行没有表单可提交：打开就是「再连一次」，按钮走 `onDirect`。
  const footer = noAuth ? (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        取消
      </Button>
      <Button loading={busy} onClick={onDirect} title="按原来的参数再连一次（不保存）">
        连接一次
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose} disabled={busy}>
        取消
      </Button>
      <Button
        type="submit"
        form={UNSAVED_FORM_ID}
        loading={busy}
        disabled={password.trim() === "" || (needsUser && username.trim() === "")}
        title="用上面填的账号与口令连一次（不保存）"
      >
        连接一次
      </Button>
    </>
  );

  return (
    <Modal
      open
      size="sm"
      title={noAuth ? "这台机器不用口令" : "口令不在本机"}
      onClose={busy ? () => undefined : onClose}
      footer={footer}
    >
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg",
              toneClass(brokerTone(kind)),
            )}
          >
            <IconPlug className="size-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-(length:--text-app-meta) font-medium text-slate-800">
              {name ? `${name} · ` : ""}
              {BROKER_LABEL[kind] ?? item.kind}
            </p>
            <p className="truncate font-mono text-(length:--text-app-micro) text-meta">
              {item.endpoint}
            </p>
          </div>
        </div>

        <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
          {noAuth
            ? "这台机器当初是不带认证连上的，地址还留着，直接再连一次就行。"
            : "地址还留着，口令当初没勾「保存此连接」，所以不在本机。"}
        </p>

        {noAuth ? null : (
          <form
            id={UNSAVED_FORM_ID}
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              onConnect({ username: username.trim(), password });
            }}
          >
            <Field label="用户名" hint={needsUser ? undefined : "上次填过的账号，改了就按新的连"}>
              <Input
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                placeholder="username"
                autoComplete="off"
                autoFocus
              />
            </Field>
            <Field label="口令">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                placeholder="password"
                autoComplete="off"
              />
            </Field>
          </form>
        )}

        {/* 另一条路放在下面，用一条分隔线跟上面的主表单隔开：
            它不是次等选择，是另一个目的 —— 想把它留成记录。 */}
        <div className="border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onFill}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-(length:--text-app-meta) text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50"
          >
            <IconRepeat className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              去填参数
              <span className="ml-1 font-normal text-meta">
                {noAuth
                  ? "地址已带上，要加 TLS / SASL / vhost，或者想把它留成记录"
                  : "地址已带上，还能改 TLS / SASL / vhost，勾保存就留成记录"}
              </span>
            </span>
            <IconForward className="size-3.5 shrink-0" />
          </button>
        </div>
      </div>
    </Modal>
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
  const hint = brokerMetaOf(kind);
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
 * 首页那张表里的一行。
 *
 * 行与行之间只有一件事不同：口令在不在本机。所以键位、悬停、删除都长一样，
 * 差别只在标记和主操作上 ——
 *
 * - 口令在（能直接回去）：`重连` + `编辑连接`，和以前保存过的记录一致；
 * - 口令不在（参数不全）：主操作是 `补口令`，点开先问一句「补一次还是去填参数」。
 *
 * 缺口令时不给常亮的「重连」：那按钮点了必定失败。让人点了收一句报错，
 * 比一开始就不写更伤人 —— 他会以为是自己填错了什么。
 */
function HistoryRow({
  item,
  entry,
  labels,
  busy,
  openBusy,
  onReconnect,
  onEdit,
  onOpen,
  onRemove,
}: {
  item: ConnectionHistoryItem;
  /** 保存过的那条配置；为空表示这条只有地址，参数已经不在本机。 */
  entry: SavedConnection | null;
  /** 中间件的显示名：名字与它相同时不重复写一遍。 */
  labels: readonly string[];
  /** 这一条正在连。 */
  busy: boolean;
  /** 「补口令」弹窗正在连（表单在弹窗里，不在行上）。 */
  openBusy: boolean;
  onReconnect: () => void;
  onEdit: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const kind = item.kind as BrokerKind;
  const name = displayName(item, labels);
  const Icon = brokerIcon(kind);
  const ready = canReconnect(item) && entry !== null;
  // 徽标只说「缺」：用不上口令的机器没缺东西，标上去等于替它报一次不存在的错。
  const missing = secretStateOf(item) === "missing";
  // 点开小弹窗时填什么，跟着这一行的性质走：要口令的补口令，不要的问参数。
  const openLabel = secretLabelOf(item);
  const user = entry?.config.auth.username?.trim();
  // 名字被省略时（自动填的「Kafka」、或就是主机段），用中间件名顶上，
  // 免得这一行读起来只剩一串地址。
  const title = name || BROKER_LABEL[kind] || item.kind;

  return (
    <Card
      className={cn(
        "flex items-center gap-3.5 px-4 py-3 transition-colors hover:ring-slate-300",
        ready ? undefined : "bg-white/60",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          toneClass(brokerTone(kind)),
        )}
      >
        {Icon ? <Icon size={16} /> : <IconPlug className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        {/* 第一行：名字 + 中间件 + 用户 + 口令标记；第二行：端点。
            标记跟着名字而不是单独占一行 —— 它是这一行的属性，不是一条消息。 */}
        <p className="flex items-baseline gap-2 truncate text-(length:--text-app-body) font-medium text-slate-900">
          <span className="truncate">{title}</span>
          {name ? (
            <span className="shrink-0 text-(length:--text-app-micro) font-normal text-meta">
              {BROKER_LABEL[kind] ?? item.kind}
            </span>
          ) : null}
          {user ? (
            <span className="shrink-0 text-(length:--text-app-micro) font-normal text-meta">
              · {user}
            </span>
          ) : null}
          {/* 标记只标「缺什么」，不标「有什么」：每一行都挂一枚「已存口令」，
              等于往表里加了一列恒为真的信息。干净的默认状态不用写出来。 */}
          {missing ? (
            <span className="shrink-0">
              <Badge tone="warning">口令不在本机</Badge>
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 truncate font-mono text-(length:--text-app-meta) text-meta">
          {item.endpoint}
        </p>
      </div>
      {ready ? (
        <>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            编辑连接
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={onReconnect}
            title={busy ? `正在连接 ${title}` : `重新连接 ${title}`}
          >
            {reconnectLabel(title, busy)}
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" loading={openBusy} onClick={onOpen}>
          {openLabel}
        </Button>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`从记录里删除 ${title}`}
        title={`从记录里删除 ${title}`}
        className="shrink-0 rounded-md p-1.5 text-meta transition-colors hover:bg-rose-50 hover:text-rose-600"
      >
        <IconTrash className="size-3.5" />
      </button>
    </Card>
  );
}
