import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Server } from "lucide-react";

import { Button, Field, Input, Modal } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { cn } from "@/lib/cn";
import { isTypingTarget } from "@/lib/command-palette";
import { connectFailure, focusField, type ConnectFailure } from "@/lib/connect-failure";
import { toAppError } from "@/lib/errors";
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

/**
 * 向导当前的进度。
 *
 * `kind` 为空 = 停在第一步（选类型）；非空 = 进第二步。把它做成一个字段而不是
 * 两个 `useState`，是为了让「上一步」只是把 `kind` 抹掉，而不是另外维护一份布尔量 ——
 * 两份状态迟早会互相矛盾（比如退回了第一步，但表单里还留着 Kafka 的地址）。
 */
type Builder = {
  kind: BrokerKind | null;
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
  /**
   * `initialKind` 只是「预先高亮哪张卡」的提示，不再是「跳过第一步」的意思。
   *
   * 之前它和 `picked` 搅在一起：传了 kind 就当成已经有了选择，于是顶栏「＋」
   * 带着 `?new=1` 进来时 `target.kind` 是 null，向导却只是**盖在首页上**打开 ——
   * 底下的内容还是那张「开始使用 / 连接记录」的页面（用户截图里看到的就是这个）。
   * 现在第一步永远先问「连哪种」，类型只是个可选高亮。
   */
  const [draft, setDraft] = useState<Builder>(() =>
    initialSaved ? savedToBuilder(initialSaved) : { kind: null, name: "" },
  );

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

  const submit = (config: ConnectionConfig) => {
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
  };

  // 关掉再打开时要回到初始步骤：这是向导自身的状态，上一轮的「选了 Kafka」
  // 不该带给下一次新建。
  // 只有「编辑记录」才跳过第一步 —— 类型早就定了，再选一次是多余动作。
  // 其余入口（首页卡片、顶栏「＋」）都从「连哪种」开始，`initialKind` 只负责高亮。
  const step: "kind" | "form" = draft.kind ? "form" : "kind";
  const kind = draft.kind;
  const shellRef = useRef<HTMLDivElement>(null);
  // 编辑已有记录时「上一步」没有去处：类型早就定了，退回去只会看到两张卡片。
  const canGoBack = step === "form" && !draft.saved && !initialSaved;

  /**
   * 键盘路径。
   *
   * 第二步：`Enter` 已有表单原生行为，`⌘Enter` / `Ctrl+Enter` 也提交；
   * `⌘←` / `Ctrl+←` 回上一步。
   * 第一步：`↑` `↓` 挪动高亮，`Enter` 选中，`1` / `2` 直接选第几张卡。
   *
   * 两个都不能和「正在输入」抢：同一个窗口里还有命令面板、过滤框。
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
    const onKeyDown = (event: KeyboardEvent) => {
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

      const inForm = event.target instanceof Element && event.target.closest(`#${FORM_ID}`) !== null;
      if (!inForm) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "Enter") {
        if (step !== "form") return;
        event.preventDefault();
        // 走表单自己的提交：`requestSubmit` 会带上浏览器校验，空地址不会发到网络上。
        shellRef.current?.querySelector<HTMLFormElement>(`#${FORM_ID}`)?.requestSubmit();
        return;
      }
      if (event.key === "ArrowLeft") {
        if (!canGoBack || busy) return;
        event.preventDefault();
        setDraft((prev) => ({ ...prev, kind: null, saved: undefined }));
      }
    };
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
              <Button
                variant="ghost"
                onClick={() => setDraft((prev) => ({ ...prev, kind: null, saved: undefined }))}
                disabled={busy}
              >
                <ArrowLeft className="size-3.5" />
                上一步
              </Button>
            ) : null}
            <Button variant="ghost" onClick={close} disabled={busy}>
              取消
            </Button>
            <Button type="submit" form={FORM_ID} loading={busy} title="连接（⌘/Ctrl + Enter）">
              连接
            </Button>
          </>
        )
      }
    >
      <div ref={shellRef} className="contents">
        {step === "kind" || !kind ? (
          <KindStep
            onPick={(next) => setDraft({ kind: next, name: "" })}
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
            onNameChange={(name) => setDraft((prev) => ({ ...prev, name }))}
            // 失败的翻译结果留在表单上方，而不是只跟在 toast 里：toast 六秒就没了，
            // 而人这时正要改字段。`error` 是 mutation 自己的状态，重开弹窗自然清掉。
            failure={
              openConnection.error
                ? connectFailure(
                    toAppError(openConnection.error),
                    endpointOf(draft, initialSaved ?? null),
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
    <div className="flex flex-col gap-3">
      <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
        先选一种中间件，下一步填它的连接地址与凭据。
        <span className="ml-1 text-meta">（↑↓ 选，Enter 确认，或直接按 1 / 2）</span>
      </p>
      {/* `data-wizard-keys` 是向导键盘路径的作用域：打开弹窗时这里拿焦点，
          `↑↓` / `Enter` / 数字键才生效，不会跑去抢过滤框里的按键。 */}
      <div
        data-wizard-keys
        tabIndex={-1}
        className="flex flex-col gap-2 outline-none"
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
  draft,
  kind,
  save,
  onSaveChange,
  onSubmit,
  initialSaved,
  onNameChange,
  failure,
}: {
  draft: Builder;
  kind: BrokerKind;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  onSubmit: (config: ConnectionConfig) => void;
  initialSaved: SavedConnection | null;
  onNameChange: (name: string) => void;
  failure: ConnectFailure | null;
}) {
  const saved = draft.saved ?? initialSaved;
  const editing = Boolean(saved);
  // 表单初值：优先用那一条记录，其次交给表单自己读草稿 / 默认值。
  const initialConfig = saved ? saved.config : null;

  return (
    <div className="flex flex-col gap-4">
      {/* 报错放在字段上方而不是页脚：人看完要接着改的就是下面这些输入框，
          放在页脚则要先把视线从按钮挪回上半屏。 */}
      {failure ? <FailureNotice failure={failure} /> : null}

      <p className="text-(length:--text-app-meta) leading-relaxed text-meta">
        {KIND_SUMMARY[kind]}
        {editing ? " · 改完保存会覆盖同名同类型的记录" : ""}
      </p>

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

/** 报错摘要里指认「刚才连的是哪儿」的那一段地址。 */
function endpointOf(draft: Builder, saved: SavedConnection | null): string | undefined {
  const source = draft.saved ?? saved;
  if (!source) return undefined;
  const config = source.config;
  return config.kind === "kafka" ? config.brokers.join(", ") : `${config.host}:${config.port}`;
}

/** 一条保存过的记录 → 向导第二步的形态（带原名与原配置）。 */
function savedToBuilder(saved: SavedConnection): Builder {
  return { kind: saved.config.kind, saved, name: saved.name };
}

/** 焦点是否落在向导自己的元素里；`null` 的 target（比如 window）算不在。 */
function containsWizard(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-wizard-keys]") !== null;
}

/** 第一步可选的那几张卡片，按视觉顺序。 */
function kindList(root: ParentNode | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLButtonElement>("[data-wizard-keys] [role=option]"));
}

/** 把焦点交给卡片容器本身（不是某张卡）：`↓` 才能从第一张开始。 */
function focusKindList(root: ParentNode | null): void {
  const scroller = root?.querySelector<HTMLElement>("[data-wizard-keys]");
  scroller?.focus();
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
