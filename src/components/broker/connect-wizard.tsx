import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Input, Modal } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { IconBack, IconForward, IconRepeat, IconServer } from "@/lib/icons";
import { isTypingTarget } from "@/lib/keyboard";
import { connectFailure, focusField, type ConnectFailure } from "@/lib/connect-failure";
import { toAppError } from "@/lib/errors";
import { BROKER_LABEL } from "@/lib/nav";
import { clearDraft, type SavedConnection } from "@/lib/session-storage";
import {
  baseWithEndpoint,
  containsWizard,
  defaultName,
  endpointLabel,
  focusKindList,
  initialDraft,
  kindList,
} from "@/lib/connect-wizard";
import { BROKER_META, type BrokerKind, type ConnectionConfig } from "@/types";
import { CONNECT_FORM_ID } from "@/types/connection";
import type { ConnectBuilder } from "@/types/connection";

import { ConnectionFormKafka } from "./connection-forms/kafka-form";
import { ConnectionFormRabbitMq } from "./connection-forms/rabbitmq-form";

/**
 * 新建连接向导：先定中间件，再填参数。
 *
 * 定中间件有两条路，取决于**用户在哪一点**：
 *
 * - 从首页的中间件卡片、新建行的按钮、记录行的「编辑连接」进来时，类型已经由
 *   那一下点击给定了 —— 直接进表单。都点过「Kafka」这一张卡了，弹窗再问一遍
 *   「连哪种」，是在让用户重复自己刚做过的决定；
 * - 从顶栏「＋」进来时没有任何前置选择 —— 第一步才真的问「连哪种」。
 *
 * 无论走哪条路，第一步都还在：表单上方挂一个「换一种中间件」，走错了就能退回去。
 * 步骤不是由入口决定的常量，而是「当前有没有类型」这个状态 —— 少一份需要同步的布尔量。
 */

export function ConnectWizard({
  open,
  /** 初始中间件：只用来在第一步里预先高亮一张卡片。 */
  initialKind,
  /** 初始要编辑的记录；有值时跳过第一步，直接进表单。 */
  initialSaved,
  /**
   * 只记得地址的历史（`recent-connections` 没有口令）：
   * 有值时进表单，并把地址预填进去 —— 用户只需要补口令。
   */
  initialEndpoint,
  onClose,
}: {
  open: boolean;
  /**
   * 入口已经定下的中间件。有值时直接进表单，为空才从「连哪种」问起。
   *
   * 早先它只是「预先高亮哪张卡」：从首页卡片点 Kafka 进来，弹窗仍然停在第一步，
   * 让人把刚做过的那次选择再做一遍。现在它是真正的初始状态 —— 点过卡片就填参数，
   * 只有顶栏「＋」（没有前置选择）才问类型。
   */
  initialKind?: BrokerKind | null;
  /** 初始要编辑的记录；带原名、原配置，跳过第一步。 */
  initialSaved?: SavedConnection | null;
  /** 历史里只留下的地址：进表单并预填，口令由用户补。 */
  initialEndpoint?: string | null;
  onClose: () => void;
}) {
  const openConnection = useOpenConnection();
  const [save, setSave] = useState(false);
  /** 打开时的初始形态：编辑记录优先，其次入口指定的类型，都没有就停在第一步。 */
  const [draft, setDraft] = useState<ConnectBuilder>(() => ({
    ...initialDraft(initialSaved, initialKind),
    endpoint: initialEndpoint ?? null,
  }));

  const busy = openConnection.isPending;

  /**
   * 回来改字段时，把光标放到最可能出错的那一格。
   *
   * 只处理「凭据」与「TLS」两类：地址、端口写没写错，人得自己看一眼原文，
   * 抢走焦点反而是打断。这两类不一样 —— 口令字段是空着的，跳过去就能改。
   */
  const failureField = openConnection.error
    ? connectFailure(toAppError(openConnection.error)).field
    : null;
  const lastFocused = useRef<string | null>(null);
  useEffect(() => {
    if (!failureField) {
      // 重新提交后要能再跳一次：否则第二次还是同一个错，光标就停在原地不动。
      lastFocused.current = null;
      return;
    }
    if (failureField === lastFocused.current) return;
    lastFocused.current = failureField;
    focusField(failureField);
  }, [failureField]);

  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  /**
   * 提交一份配置。
   *
   * 记为「失败时不动草稿」：只有连上了才清 —— 草稿是用户填过的东西，
   * 连接失败还把它清掉，下一次得从零开始填。
   */
  const submit = useCallback(
    (config: ConnectionConfig) => {
      const name = draft.name.trim() || defaultName(config);
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
    },
    [draft.name, openConnection, save, onClose],
  );

  /**
   * 回到「连哪种」。
   *
   * 到这一步才把类型抹掉，名字留着 —— 用户只是走错了卡片，不该连名字一起丢。
   * 编辑记录时也允许：从 Kafka 退回去改成 RabbitMQ，等于换成新建，`saved` 一并清掉。
   */
  const backToKind = useCallback(() => {
    setDraft((prev) => ({ ...prev, kind: null, saved: undefined }));
  }, []);

  // 步骤只看「当前有没有类型」：有就填参数，没有就问连哪种。上一轮的「选了 Kafka」
  // 不会带给下一次新建 —— `draft` 是向导自己的状态，重开时由 `initialDraft` 重建。
  const step: "kind" | "form" = draft.kind ? "form" : "kind";
  const kind = draft.kind;
  const shellRef = useRef<HTMLDivElement>(null);
  // 页脚的「上一步」只给新建用；编辑记录时退回第一步没有意义（类型早就定了），
  // 那种情况下的换类型走表单上方的「换一种中间件」。
  const canGoBack = step === "form" && !draft.saved && !initialSaved;

  /**
   * 键盘路径。
   *
   * 第二步：`Enter` 已有表单原生行为，`⌘Enter` / `Ctrl+Enter` 也提交；
   * `⌘←` / `Ctrl+←` 回上一步。
   * 第一步：`↑` `↓` 挪动高亮，`Enter` 选中，`1` / `2` 直接选第几张卡。
   *
   * 两个都不能和「正在输入」抢：同一个窗口里还有搜索框、过滤框。
   * 所以键盘动作要求焦点落在向导自己在管的元素上 —— 第一步是 `data-wizard-keys`
   * 标记的卡片容器（打开时就拿到了焦点），第二步是带 `#connect-form` 的表单。
   */
  // 第一步打开就把焦点交给卡片容器：`↑↓` 立刻可用，不用先 Tab 一次。
  // 只在「切到第一步」时做，第二步不抢输入框的 `autoFocus`。
  useEffect(() => {
    if (!open || step !== "kind") return;
    focusKindList(shellRef.current);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    // 键盘路径与向导的步骤绑定：只在「向导开着」时挂监听，随 `step` 重挂。
    function onKeyDown(event: KeyboardEvent) {
      const inWizard = containsWizard(event.target);

      if (step === "kind") {
        if (isTypingTarget(event.target)) return;
        if (!inWizard) return;
        const list = kindList(shellRef.current);
        if (list.length === 0) return;
        // 焦点通常落在卡片容器上（不是某张卡），此时按 -1 处理：↓ 从第一张开始。
        const current = list.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          list[(current + delta + list.length) % list.length]?.focus();
          return;
        }
        if (event.key === "Enter" && inWizard) {
          // 焦点在卡片上时回车就是「选它」，别让它冒泡到任何外层。
          event.preventDefault();
          list[current >= 0 ? current : 0]?.click();
          return;
        }
        const digit = Number(event.key);
        if (digit >= 1 && digit <= list.length) {
          event.preventDefault();
          list[digit - 1]?.click();
        }
        return;
      }

      const inForm = event.target instanceof Element && event.target.closest(`#${CONNECT_FORM_ID}`) !== null;
      if (!inForm) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter") {
        if (step !== "form") return;
        event.preventDefault();
        // 走表单自己的提交：`requestSubmit` 会带上浏览器校验，空地址不会发到网络上。
        shellRef.current?.querySelector<HTMLFormElement>(`#${CONNECT_FORM_ID}`)?.requestSubmit();
        return;
      }
      if (event.key === "ArrowLeft") {
        if (busy) return;
        event.preventDefault();
        backToKind();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, step, canGoBack, busy]);

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
            {canGoBack ? (
              <Button variant="ghost" onClick={backToKind} disabled={busy}>
                <IconBack className="size-3.5" />
                上一步
              </Button>
            ) : null}
            <Button variant="ghost" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button type="submit" form={CONNECT_FORM_ID} loading={busy} title="连接（⌘/Ctrl + Enter）">
              连接
            </Button>
          </>
        )
      }
    >
      <div ref={shellRef} className="contents">
        {step === "kind" || !kind ? (
          <KindStep
            // 换类型时把名字带过去：从表单退回来重选，人多半只是点错了卡片。
            onPick={(next) => setDraft((prev) => ({ ...prev, kind: next }))}
            selected={kind ?? initialKind ?? null}
          />
        ) : (
          <FormStep
            // 换类型 / 换记录时整套重建表单：输入框里不能留着上一条的地址。
            key={`${kind}:${draft.saved?.id ?? initialSaved?.id ?? "new"}`}
            draft={draft}
            kind={kind}
            save={save}
            onSaveChange={setSave}
            onSubmit={submit}
            initialSaved={initialSaved ?? null}
            initialEndpoint={draft.endpoint ?? initialEndpoint ?? null}
            onNameChange={(name) => setDraft((prev) => ({ ...prev, name }))}
            // 表单上方的「换一种中间件」：编辑记录时也能用（换类型 = 转成新建）。
            onChangeKind={busy ? undefined : backToKind}
            // 失败的翻译结果留在表单上方，而不是只跟在 toast 里：toast 六秒就没了，
            // 而人这时正要改字段。`error` 是 mutation 自己的状态，重开弹窗自然清掉。
            failure={
              openConnection.error
                ? connectFailure(
                    toAppError(openConnection.error),
                    endpointLabel(draft, initialSaved ?? null),
                  )
                : null
            }
          />
        )}
      </div>
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
    <div className="flex flex-col gap-4">
      <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
        先选一种中间件，下一步填它的连接地址与凭据。
        <span className="ml-1 text-meta">（↑↓ 选，Enter 确认，或按 1 / 2）</span>
      </p>
      {/* `data-wizard-keys` 是向导键盘路径的作用域：打开弹窗时这里拿焦点，
          `↑↓` / `Enter` / 数字键才生效，不会跑去抢过滤框里的按键。 */}
      <div
        data-wizard-keys
        tabIndex={-1}
        className="flex flex-col gap-2.5 outline-none"
        role="listbox"
        aria-label="选择中间件"
      >
        {list.map((plugin) => (
          <button
            key={plugin.kind}
            type="button"
            role="option"
            aria-selected={selected === plugin.kind}
            data-kind={plugin.kind}
            onClick={() => onPick(plugin.kind)}
            className={cn(
              "group flex items-center gap-4 rounded-xl bg-white p-4 text-left shadow-xs transition-colors",
              "ring-1 ring-slate-200/80 hover:ring-indigo-400",
              selected === plugin.kind && "ring-indigo-500 bg-indigo-50/40",
            )}
          >
            <span
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-xl",
                plugin.kind === "kafka"
                  ? "bg-amber-50 text-broker-kafka"
                  : "bg-violet-50 text-broker-rabbitmq",
              )}
            >
              <IconServer className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="text-(length:--text-app-title) font-semibold text-slate-900">
                  {plugin.displayName}
                </span>
                <span className="text-(length:--text-app-micro) text-meta">
                  默认端口 {BROKER_META[plugin.kind].port}
                </span>
              </span>
              <span className="mt-1 block truncate text-(length:--text-app-meta) text-meta">
                {BROKER_META[plugin.kind].summary}
              </span>
            </span>
            <IconForward className="size-4 shrink-0 text-meta transition-colors group-hover:text-indigo-600" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** 第二步：连接名 + 参数表单。 */
function FormStep({
  draft,
  kind,
  save,
  onSaveChange,
  onSubmit,
  initialSaved,
  initialEndpoint,
  onNameChange,
  onChangeKind,
  failure,
}: {
  draft: ConnectBuilder;
  kind: BrokerKind;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  onSubmit: (config: ConnectionConfig) => void;
  initialSaved: SavedConnection | null;
  /** 只有地址的历史：预填地址那一格，其余仍走草稿。 */
  initialEndpoint: string | null;
  onNameChange: (name: string) => void;
  /** 回到第一步换类型；`undefined` 表示正在提交，先别动。 */
  onChangeKind?: () => void;
  failure: ConnectFailure | null;
}) {
  const saved = draft.saved ?? initialSaved;
  const editing = Boolean(saved);
  /**
   * 表单初值：优先用那一条记录；其次若是「只记得地址」的历史，就用草稿 / 默认值
   * 拼一份配置、只把地址那格换掉 —— 口令依旧空着，属于用户要补的东西。
   */
  const initialConfig = saved
    ? saved.config
    : initialEndpoint
      ? baseWithEndpoint(kind, initialEndpoint)
      : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 类型写在表单最上面，并且能改：从卡片点进来时这一步是省掉的，
          但「我刚才是不是点错了」这个念头得有地方落。 */}
      <div className="flex items-center gap-2">
        <IconServer className="size-3.5 shrink-0 text-meta" />
        <span className="text-(length:--text-app-meta) text-secondary">
          正在配置 <span className="font-medium text-slate-800">{BROKER_LABEL[kind]}</span>
          {" · "}
          {BROKER_META[kind].summary}
        </span>
        {onChangeKind ? (
          <button
            type="button"
            onClick={onChangeKind}
            className="ml-auto shrink-0 rounded-md px-2 py-1 text-(length:--text-app-micro) text-indigo-600 transition-colors hover:bg-indigo-50"
          >
            <IconRepeat className="mr-0.5 inline size-3" />
            换一种中间件
          </button>
        ) : null}
      </div>

      {/* 报错放在字段上方而不是页脚：人看完要接着改的就是下面这些输入框，
          放在页脚则要先把视线从按钮挪回上半屏。 */}
      {failure ? <FailureNotice failure={failure} /> : null}

      {editing ? (
        <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
          改完保存会覆盖同名同类型的记录
        </p>
      ) : null}

      <Field label="连接名称（可选）" hint="同名同类型会覆盖已保存的连接">
        <Input
          value={draft.name || saved?.name || ""}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder={kind === "kafka" ? "例如：本地 Kafka" : "例如：本地 RabbitMQ"}
          autoFocus
        />
      </Field>

      {kind === "kafka" ? (
        <ConnectionFormKafka
          formId={CONNECT_FORM_ID}
          onSubmit={onSubmit}
          save={save}
          onSaveChange={onSaveChange}
          initialConfig={initialConfig?.kind === "kafka" ? initialConfig : null}
        />
      ) : (
        <ConnectionFormRabbitMq
          formId={CONNECT_FORM_ID}
          onSubmit={onSubmit}
          save={save}
          onSaveChange={onSaveChange}
          initialConfig={initialConfig?.kind === "rabbitMq" ? initialConfig : null}
        />
      )}
    </div>
  );
}

/**
 * 连接失败的现场提示：结论 + 一句动作，原文折叠在里面。
 *
 * 后端原文（`Local: Broker transport failure`）不是给人读的，但它有时是唯一线索，
 * 所以不删——只是默认收起。识别不出类型时反过来：摘要就是原文，不硬编结论。
 */
function FailureNotice({ failure }: { failure: ConnectFailure }) {
  return (
    <div
      role="alert"
      className="animate-fade-in rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-(length:--text-app-meta)"
    >
      <p className="font-medium text-rose-700">{failure.summary}</p>
      {failure.hint ? <p className="mt-0.5 leading-relaxed text-slate-600">{failure.hint}</p> : null}
      <details className="mt-1 group">
        <summary className="cursor-pointer list-none text-(length:--text-app-micro) text-meta hover:text-slate-700">
          技术原文
        </summary>
        <p className="selectable mt-1 break-words font-mono text-(length:--text-app-micro) leading-relaxed text-secondary">
          {failure.detail}
        </p>
      </details>
    </div>
  );
}
