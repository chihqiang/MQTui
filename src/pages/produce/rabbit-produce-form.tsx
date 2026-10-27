import { useMemo, useState } from "react";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ComboInput,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { useTopology } from "@/hooks/use-broker-data";
import { messageService } from "@/services";
import { useSessionStore } from "@/stores";
import { errorMessage } from "@/lib/errors";
import {
  DEFAULT_DELIVERY_MODE,
  DELIVERY_MODES,
  exchangeName,
  sendBlockers,
  toHeaders,
  type DeliveryMode,
  type HeaderRow,
} from "@/lib/produce";
import type { ConnectionSummary } from "@/types";

/**
 * RabbitMQ 发送表单：exchange + routing key + 投递模式 + headers + payload。
 *
 * 这几格都不是「附赠」：
 * - 不给 exchange 就等于默认交换机，消息按 routing key 直投同名队列，
 *   而绑定到某个 fanout / topic 交换机上的队列一条都收不到；
 * - 投递模式决定消息能不能活过 broker 重启，以前被硬编码成非持久化；
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

  const blocked = sendBlockers({ kind: "rabbitMq", exchange, routingKey, payload });

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
          </div>

          <Field label="Headers（可选）" hint="trace-id 这类链路信息放这里；key 空着的行不会发送">
            <div className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(event) => {
                      const next = [...rows];
                      next[index] = { ...row, key: event.currentTarget.value };
                      setRows(next);
                    }}
                    placeholder="key"
                    className="min-w-0 flex-1 font-mono"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => {
                      const next = [...rows];
                      next[index] = { ...row, value: event.currentTarget.value };
                      setRows(next);
                    }}
                    placeholder="value"
                    className="min-w-0 flex-1 font-mono"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRows(rows.filter((_, position) => position !== index))}
                  >
                    删除
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRows([...rows, { key: "", value: "" }])}
                >
                  加一行 header
                </Button>
              </div>
            </div>
          </Field>

          <Field label="Payload">
            <Textarea
              rows={10}
              value={payload}
              onChange={(event) => setPayload(event.currentTarget.value)}
              required
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
