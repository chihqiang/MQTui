import { useState } from "react";

import { Button, Card, CardBody, CardHeader, Field, Input, Textarea } from "@/components/ui";
import { useSessionStore } from "@/stores";
import { errorMessage } from "@/lib/errors";
import { messageService } from "@/services";

/** 发送消息：Kafka 发到 topic，RabbitMQ 发到 exchange + routing key。 */
export function ProducePage() {
  const connectionId = useSessionStore((state) => state.activeConnectionId);
  const pushToast = useSessionStore((state) => state.pushToast);

  const [target, setTarget] = useState("");
  const [exchange, setExchange] = useState("");
  const [key, setKey] = useState("");
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const send = async () => {
    if (!connectionId) return;
    setSubmitting(true);
    try {
      const outcome = await messageService.sendMessage({
        connectionId,
        target,
        key: key || undefined,
        payload,
        headers: [],
        exchange: exchange || undefined,
      });
      pushToast("success", `发送成功：${outcome.detail}`);
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6">
      <Card>
        <CardHeader title="发送消息" />
        <CardBody>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="目标（topic / routing key）">
                <Input value={target} onChange={(event) => setTarget(event.currentTarget.value)} required />
              </Field>
              <Field label="Exchange（仅 RabbitMQ）">
                <Input value={exchange} onChange={(event) => setExchange(event.currentTarget.value)} />
              </Field>
            </div>

            <Field label="Key（可选）">
              <Input value={key} onChange={(event) => setKey(event.currentTarget.value)} />
            </Field>

            <Field label="Payload">
              <Textarea
                rows={10}
                value={payload}
                onChange={(event) => setPayload(event.currentTarget.value)}
                required
              />
            </Field>

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? "发送中…" : "发送"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
