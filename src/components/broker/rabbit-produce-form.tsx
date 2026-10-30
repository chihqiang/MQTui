import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Card,
  CardHeader,
  ComboInput,
  Field,
  SectionTitle,
  Select,
  Textarea,
} from "@/components/ui";
import { HeaderEditor } from "@/components/broker/header-editor";
import { ProduceResultRow, type ProduceResult } from "@/components/broker/produce-result";
import { ProduceSendBar, submitShortcutLabel } from "@/components/broker/produce-send-bar";
import { SendRoutePreview } from "@/components/broker/send-route-preview";
import { useTopology } from "@/hooks/use-broker-data";
import { messageService } from "@/services";
import { cn } from "@/lib/cn";
import { messagesPath } from "@/lib/actions";
import { errorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { IconChevronDown } from "@/lib/icons";
import {
  CONTENT_ENCODINGS,
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_DELIVERY_MODE,
  DELIVERY_MODES,
  changedOptionCount,
  contentField,
  exchangeName,
  guessContentType,
  headerFingerprint,
  payloadBytes,
  sendBlockers,
  toHeaders,
  type DeliveryMode,
  type HeaderRow,
} from "@/lib/produce";
import type { ConnectionSummary } from "@/types";

/**
 * 上次用过的投递选项（进程内记忆）。
 *
 * 发消息往往连着发好几个同一批参数：每次进页面都要重新选「持久化 + application/json」
 * 是纯重复劳动。只记这三项 —— headers 与正文属于**这一条**消息，跟着记住更容易发错。
 */
let lastAdvanced: {
  deliveryMode: DeliveryMode;
  contentType: string;
  contentEncoding: string;
} | null = null;

/**
 * RabbitMQ 发送表单：exchange + routing key + 投递模式 + 内容类型 + headers + payload。
 *
 * 版式与 Kafka 那侧保持一致：首屏只露「目标 + 正文」，其余收进「高级选项」，
 * 发送条常驻底部，结果留在页面上。
 *
 * 高级选项里的每一格都不是「附赠」，所以它们只是收起来、不是删掉：
 * - 不给 exchange 就等于默认交换机，消息按 routing key 直投同名队列，
 *   而绑定到某个 fanout / topic 交换机上的队列一条都收不到；
 * - 投递模式决定消息能不能活过 broker 重启，以前被硬编码成非持久化；
 * - 内容类型决定下游怎么理解这段字节，以前被硬编码成 `text/plain`；
 * - headers 是 trace-id 这类链路信息唯一的去处。
 */
export function RabbitProduceForm({
  connection,
  presetTarget,
}: {
  connection: ConnectionSummary;
  /** 从消息页带过来的 routing key（`?target=`）。 */
  presetTarget: string | null;
}) {
  const connectionId = connection.id;
  const { data: topology } = useTopology(connectionId, true);

  const [exchange, setExchange] = useState("");
  const [routingKey, setRoutingKey] = useState(presetTarget ?? "");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(
    lastAdvanced?.deliveryMode ?? DEFAULT_DELIVERY_MODE,
  );
  const [contentType, setContentType] = useState(lastAdvanced?.contentType ?? DEFAULT_CONTENT_TYPE);
  const [contentEncoding, setContentEncoding] = useState(lastAdvanced?.contentEncoding ?? "");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ProduceResult | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);

  const exchangeChoices = useMemo(
    () =>
      (topology?.exchanges ?? [])
        .filter((item) => item.name)
        .map((item) => ({ value: item.name, hint: item.exchangeType })),
    [topology],
  );
  // routing key 候选跟着填好的 exchange 走；exchange 空着时给全部绑定上的 key。
  const keyChoices = useMemo(
    () => [
      ...new Set(
        (topology?.bindings ?? [])
          .filter((item) => item.routingKey && (!exchange || item.source === exchange))
          .map((item) => item.routingKey),
      ),
    ],
    [topology, exchange],
  );

  const bytes = payloadBytes(payload);
  const blocked = sendBlockers({
    kind: "rabbitMq",
    exchange,
    routingKey,
    contentType,
    contentEncoding,
    payload,
  });
  const changedOptions = changedOptionCount({
    kind: "rabbitMq",
    deliveryMode,
    contentType,
    contentEncoding,
    headers: rows,
  });
  const shortcut = submitShortcutLabel();

  /**
   * 发送预览：这条消息会投到哪些队列。
   *
   * 只在「交换机 + routing key 有其一」时才算 —— 都没填时结论必然为空，
   * 而用户只是还没填完，那不是提示，那是噪音。
   *
   * 与拓扑共用同一份缓存 key（`loadTopology` 已经拉过交换机与绑定），
   * 这里拉的是后端算好的匹配结果：routing key 与交换机类型决定的一切
   * 都留在 Rust 里，前端不重写一遍 AMQP 的匹配规则。
   */
  const trimmedKey = routingKey.trim();
  const previewEnabled = exchange.trim() !== "" || trimmedKey !== "";
  // 指纹而不是行数组：行数组每次渲染都是新引用，缓存键永远不相等。
  const headersKey = useMemo(() => headerFingerprint(rows), [rows]);
  const preview = useQuery({
    queryKey: ["sendRoute", connectionId, exchange, trimmedKey, headersKey],
    queryFn: () =>
      messageService.previewSend(connectionId, exchangeName(exchange), trimmedKey, toHeaders(rows)),
    enabled: previewEnabled,
    // 打一个字就查一次会把管理 API 打满；改完再算是够的。
    staleTime: 10_000,
  });
  const route = preview.data ?? null;

  /**
   * 目标行下方那句话：这条消息到底会不会有人收到。
   *
   * 收成一句而不是整块面板 —— 面板插在正文和发送条之间，把主动作推得更远。
   * 「没人会收到」是唯一发出去等于丢的情形，所以它单独一档颜色，且默认可见。
   */
  const routeSummary = useMemo(() => {
    if (!previewEnabled) return null;
    if (preview.error) return { tone: "muted" as const, text: "路由预览不可用（多为没配管理 API）" };
    if (!route) return { tone: "muted" as const, text: "正在算这条消息会投到哪些队列…" };
    if (route.queues.length === 0) {
      return route.bindingsKnown === false
        ? { tone: "muted" as const, text: "无法核对接到了哪些队列（队列列表没读到）" }
        : { tone: "danger" as const, text: "没有任何队列会收到这条消息，发出去等于丢" };
    }
    const names = route.queues.map((item) => item.queue);
    const head = names.slice(0, 3).join("、");
    return {
      tone: "normal" as const,
      text: `→ ${names.length} 个队列：${head}${names.length > 3 ? ` 等` : ""}`,
    };
  }, [previewEnabled, preview.error, route]);

  const guessed = useMemo(() => guessContentType(payload), [payload]);

  /** 发送成功后去看哪一条：优先预览算出来的第一个队列，否则默认交换机下按队列名找。 */
  const viewTarget = (): { path: string; label: string } | null => {
    const firstQueue = route?.queues[0]?.queue;
    if (firstQueue) {
      return { path: messagesPath(connectionId, firstQueue), label: `查看队列 ${firstQueue}` };
    }
    if (exchangeName(exchange) === "" && trimmedKey !== "") {
      return { path: messagesPath(connectionId, trimmedKey), label: `查看队列 ${trimmedKey}` };
    }
    return null;
  };

  const send = async () => {
    if (blocked || submitting) return;
    const sentBytes = payloadBytes(payload);
    const target = exchangeName(exchange) === "" ? "(默认交换机)" : exchangeName(exchange);
    const landed = route?.queues.length ?? 0;
    setSubmitting(true);
    try {
      const outcome = await messageService.sendMessage({
        kind: "rabbitMq",
        connectionId,
        exchange: exchangeName(exchange),
        routingKey: trimmedKey,
        deliveryMode,
        contentType: contentField(contentType),
        contentEncoding: contentField(contentEncoding),
        headers: toHeaders(rows),
        payload,
      });
      // 记住这一组参数：下一条大概率还是同一批。
      lastAdvanced = { deliveryMode, contentType, contentEncoding };
      const view = viewTarget();
      setResult({
        tone: landed === 0 && route?.bindingsKnown !== false ? "warning" : "success",
        title: `已投递到 ${target}`,
        detail: [
          landed > 0 ? `落到 ${landed} 个队列` : null,
          outcome.detail,
        ]
          .filter(Boolean)
          .join(" · "),
        bytes: sentBytes,
        at: Date.now(),
        viewPath: view?.path,
        viewLabel: view?.label,
      });
    } catch (error) {
      setResult({
        tone: "danger",
        title: "发送失败",
        detail: errorMessage(error),
        bytes: sentBytes,
        at: Date.now(),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="投到 exchange" />
      {/* 不用 `CardBody`：它自带 `p-4`，而 `cn` 只是拼字符串 —— 再写一个 `p-0`
          并不会赢过它（同层规则按 Tailwind 的生成顺序决定，`p-4` 在后），
          结果就是外面 16px、里面又 16px。这里要的是「自己排内边距」。 */}
      <div className="flex flex-col">
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
        >
          {/*
            左右分栏：左边是「这条消息是什么」（exchange + routing key + 正文，必填），
            右边是「附加属性」（投递模式、内容类型、编码、headers）。
            高级项常驻在右栏而不是折起来：这几项都会改变消息的行为，
            藏起来之后，上一次改过的设置要再点开确认一遍才敢发。
          */}
          <div className="grid grid-cols-1 items-start gap-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex min-w-0 flex-col gap-3 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Exchange" hint="留空即默认交换机：按 routing key 直投同名队列">
                  <ComboInput
                    value={exchange}
                    choices={exchangeChoices}
                    onValueChange={setExchange}
                    placeholder="(默认交换机)"
                  />
                </Field>
                <Field
                  label="routing key"
                  hint={
                    presetTarget && presetTarget === routingKey.trim()
                      ? "沿用消息页正在看的目标"
                      : "候选取自已有绑定"
                  }
                >
                  <ComboInput
                    value={routingKey}
                    choices={keyChoices}
                    onValueChange={setRoutingKey}
                    placeholder="order.created"
                  />
                </Field>
              </div>

              {routeSummary ? (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => setRouteOpen((open) => !open)}
                    aria-expanded={routeOpen}
                    className={cn(
                      "flex items-start gap-1 text-left text-(length:--text-app-meta) transition-colors",
                      routeSummary.tone === "danger"
                        ? "text-danger hover:text-danger/80"
                        : routeSummary.tone === "muted"
                          ? "text-meta hover:text-slate-700"
                          : "text-secondary hover:text-slate-900",
                    )}
                  >
                    <span className="min-w-0">{routeSummary.text}</span>
                    <IconChevronDown
                      size={12}
                      className={cn(
                        "mt-0.5 shrink-0 transition-transform",
                        routeOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {routeOpen ? (
                    <SendRoutePreview
                      route={route}
                      error={preview.error ? errorMessage(preview.error) : null}
                      pending={preview.isFetching}
                      onRefresh={() => void preview.refetch()}
                    />
                  ) : null}
                </div>
              ) : null}

              <Field label="Payload" hint="原样发送，不做格式化">
                <div className="flex flex-col gap-1">
                  <Textarea
                    rows={12}
                    value={payload}
                    onChange={(event) => setPayload(event.currentTarget.value)}
                    placeholder={'{"orderId":"A-1024"}'}
                    className="leading-relaxed"
                    required
                  />
                  {/* 内容类型的建议放在正文下方，而不是压在输入区右上角 ——
                      浮层按钮会盖住第一行文字，也挡住滚动条。 */}
                  {guessed && guessed !== contentType ? (
                    <p className="flex items-center gap-1.5 text-(length:--text-app-meta) text-meta">
                      <span>
                        这段看起来是 <span className="font-mono">{guessed}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setContentType(guessed)}
                        className="rounded px-1 text-indigo-600 transition-colors hover:bg-indigo-50"
                      >
                        用它
                      </button>
                    </p>
                  ) : null}
                </div>
              </Field>

              {result ? (
                <ProduceResultRow
                  result={result}
                  onClear={() => {
                    setPayload("");
                    setRows([]);
                    setResult(null);
                  }}
                />
              ) : null}
            </div>

            <aside className="flex min-w-0 flex-col gap-3 border-t border-slate-200 p-4 lg:border-t-0 lg:border-l">
              <SectionTitle extra={changedOptions ? `已改 ${changedOptions} 项` : undefined}>
                高级选项
              </SectionTitle>

              <Field
                label="投递模式"
                hint={DELIVERY_MODES.find((item) => item.value === deliveryMode)?.hint}
              >
                <Select
                  value={String(deliveryMode)}
                  onChange={(event) =>
                    setDeliveryMode(Number(event.currentTarget.value) as DeliveryMode)
                  }
                >
                  {DELIVERY_MODES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}（{item.value}）
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="内容类型"
                hint={
                  CONTENT_TYPES.find((item) => item.value === contentType)?.hint ??
                  "自定义值：下游按它决定怎么解析"
                }
              >
                <ComboInput
                  value={contentType}
                  choices={CONTENT_TYPES.map((item) => ({ value: item.value, hint: item.hint }))}
                  onValueChange={setContentType}
                  placeholder={DEFAULT_CONTENT_TYPE}
                />
              </Field>

              <Field
                label="内容编码（可选）"
                hint="只有内容真的被压缩过才填：填了 gzip 却给明文，消费端会拿到乱码"
              >
                <ComboInput
                  value={contentEncoding}
                  choices={CONTENT_ENCODINGS.map((item) => ({
                    value: item.value,
                    hint: item.hint,
                  }))}
                  onValueChange={setContentEncoding}
                  placeholder="(未编码)"
                />
              </Field>

              <HeaderEditor
                rows={rows}
                onChange={setRows}
                hint="trace-id 这类链路信息放这里；header 名给了常见候选，也能自己写"
              />
            </aside>
          </div>

          <ProduceSendBar
            blocked={blocked}
            meta={`${formatBytes(bytes)} · ${shortcut} 发送`}
            submitting={submitting}
          />
        </form>
      </div>
    </Card>
  );
}
