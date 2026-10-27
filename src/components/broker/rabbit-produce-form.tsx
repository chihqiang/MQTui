import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ComboInput,
  Field,
  Select,
  Textarea,
} from "@/components/ui";
import { HeaderEditor } from "@/components/broker/header-editor";
import { SendRoutePreview } from "@/components/broker/send-route-preview";
import { useTopology } from "@/hooks/use-broker-data";
import { messageService } from "@/services";
import { useSessionStore } from "@/stores";
import { errorMessage } from "@/lib/errors";
import {
  CONTENT_ENCODINGS,
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_DELIVERY_MODE,
  DELIVERY_MODES,
  contentField,
  exchangeName,
  guessContentType,
  sendBlockers,
  toHeaders,
  type DeliveryMode,
  type HeaderRow,
} from "@/lib/produce";
import type { ConnectionSummary } from "@/types";

/**
 * RabbitMQ 发送表单：exchange + routing key + 投递模式 + 内容类型 + headers + payload。
 *
 * 这几格都不是「附赠」：
 * - 不给 exchange 就等于默认交换机，消息按 routing key 直投同名队列，
 *   而绑定到某个 fanout / topic 交换机上的队列一条都收不到；
 * - 投递模式决定消息能不能活过 broker 重启，以前被硬编码成非持久化；
 * - 内容类型决定下游怎么理解这段字节，以前被硬编码成 `text/plain`；
 * - headers 是 trace-id 这类链路信息唯一的去处，以前这一页根本没有入口。
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
  const pushToast = useSessionStore((state) => state.pushToast);
  const { data: topology } = useTopology(connectionId, true);

  const [exchange, setExchange] = useState("");
  const [routingKey, setRoutingKey] = useState(presetTarget ?? "");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(DEFAULT_DELIVERY_MODE);
  const [contentType, setContentType] = useState(DEFAULT_CONTENT_TYPE);
  const [contentEncoding, setContentEncoding] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  const blocked = sendBlockers({
    kind: "rabbitMq",
    exchange,
    routingKey,
    contentType,
    contentEncoding,
    payload,
  });

  /**
   * 发送预览：这条消息会投到哪些队列。
   *
   * 只在「交换机 + routing key 都填完」时才算 —— 空 key 的预览结论是
   * 「没匹配上」，而用户只是还没填完，那不是提示，那是噪音。
   *
   * 与拓扑共用同一份缓存 key（`loadTopology` 已经拉过交换机与绑定），
   * 这里拉的是后端算好的匹配结果：routing key 与交换机类型决定的一切
   * 都留在 Rust 里，前端不重写一遍 AMQP 的匹配规则。
   */
  const trimmedKey = routingKey.trim();
  const previewEnabled = exchange.trim() !== "" || trimmedKey !== "";
  const preview = useQuery({
    queryKey: ["sendRoute", connectionId, exchange, trimmedKey, toHeaders(rows)],
    queryFn: () =>
      messageService.previewSend(connectionId, exchangeName(exchange), trimmedKey, toHeaders(rows)),
    enabled: previewEnabled,
    // 打一个字就查一次会把管理 API 打满；改完再算是够的。
    staleTime: 10_000,
  });

  const guessed = useMemo(() => guessContentType(payload), [payload]);

  const send = async () => {
    setSubmitting(true);
    try {
      const target = exchangeName(exchange) === "" ? "(默认交换机)" : exchangeName(exchange);
      const outcome = await messageService.sendMessage({
        kind: "rabbitMq",
        connectionId,
        exchange: exchangeName(exchange),
        routingKey: routingKey.trim(),
        deliveryMode,
        contentType: contentField(contentType),
        contentEncoding: contentField(contentEncoding),
        headers: toHeaders(rows),
        payload,
      });
      pushToast("success", `已投递到 ${target}：${outcome.detail}`);
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="投到 exchange" />
      <CardBody>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="投递模式"
              hint={DELIVERY_MODES.find((item) => item.value === deliveryMode)?.hint}
            >
              <Select
                value={String(deliveryMode)}
                onChange={(event) => setDeliveryMode(Number(event.currentTarget.value) as DeliveryMode)}
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
              hint={CONTENT_TYPES.find((item) => item.value === contentType)?.hint ?? "自定义值：下游按它决定怎么解析"}
            >
              <ComboInput
                value={contentType}
                choices={CONTENT_TYPES.map((item) => ({ value: item.value, hint: item.hint }))}
                onValueChange={setContentType}
                placeholder={DEFAULT_CONTENT_TYPE}
              />
            </Field>
          </div>

          <Field
            label="内容编码（可选）"
            hint="只有内容真的被压缩过才填：填了 gzip 却给明文，消费端会拿到乱码"
          >
            <ComboInput
              value={contentEncoding}
              choices={CONTENT_ENCODINGS.map((item) => ({ value: item.value, hint: item.hint }))}
              onValueChange={setContentEncoding}
              placeholder="(未编码)"
            />
          </Field>

          <HeaderEditor
            rows={rows}
            onChange={setRows}
            hint="trace-id 这类链路信息放这里；header 名给了常见候选，也能自己写"
          />

          <Field
            label="Payload"
            hint={
              guessed && guessed !== contentType
                ? `这段看起来是 ${guessed}，点右边改成它 —— 内容类型决定下游怎么解析`
                : undefined
            }
          >
            <div className="relative">
              <Textarea
                rows={10}
                value={payload}
                onChange={(event) => setPayload(event.currentTarget.value)}
                required
              />
              {guessed && guessed !== contentType ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="absolute top-1 right-1"
                  onClick={() => setContentType(guessed)}
                >
                  用 {guessed}
                </Button>
              ) : null}
            </div>
          </Field>

          <Field label="发送预览" hint="按当前拓扑与绑定算出来的到达队列；publish 成功但没人收到是最难查的一种">
            <SendRoutePreview
              route={preview.data ?? null}
              error={preview.error ? errorMessage(preview.error) : null}
              pending={preview.isFetching}
              onRefresh={() => void preview.refetch()}
            />
          </Field>

          <div className="flex items-center justify-end gap-3">
            {blocked ? <span className="text-(length:--text-app-meta) text-slate-500">{blocked}</span> : null}
            <Button type="submit" loading={submitting} disabled={Boolean(blocked)}>
              发送
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
