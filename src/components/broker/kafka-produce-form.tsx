import { useMemo, useState } from "react";

import { Button, Card, CardBody, CardHeader, ComboInput, Field, Textarea } from "@/components/ui";
import { useTopics } from "@/hooks/use-broker-data";
import { messageService } from "@/services";
import { useSessionStore } from "@/stores";
import { listRecentTargets, connectionMemoryKey } from "@/lib/workspace-storage";
import { errorMessage } from "@/lib/errors";
import { kafkaKey, sendBlockers } from "@/lib/produce";
import type { ConnectionSummary } from "@/types";

/**
 * Kafka 发送表单：只有 topic、key、payload 三格。
 *
 * 「共用一张表单 + 隐藏不适用的格子」试过，结论是不划算：
 * Kafka 没有交换机、没有 AMQP headers、也没有投递模式，
 * 留着它们只能是三个永远置灰的框，还要在提示里解释「这一格你不用管」。
 */
export function KafkaProduceForm({
  connection,
  presetTarget,
}: {
  connection: ConnectionSummary;
  /** 从消息页带过来的 topic（`?target=`）。 */
  presetTarget: string | null;
}) {
  const connectionId = connection.id;
  const pushToast = useSessionStore((state) => state.pushToast);
  const [topic, setTopic] = useState(presetTarget ?? "");
  const [key, setKey] = useState("");
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: topics } = useTopics(connectionId, true);
  const candidates = useMemo(() => {
    const recent = listRecentTargets(connectionMemoryKey(connection.kind, connection.endpoint));
    return [...new Set([...recent, ...(topics ?? []).map((item) => item.name)])];
  }, [connection.kind, connection.endpoint, topics]);

  const blocked = sendBlockers({ kind: "kafka", topic, payload });

  const send = async () => {
    setSubmitting(true);
    try {
      const outcome = await messageService.sendMessage({
        kind: "kafka",
        connectionId,
        topic: topic.trim(),
        key: kafkaKey(key),
        payload,
      });
      pushToast("success", `已写入 topic ${topic.trim()}：${outcome.detail}`);
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader title="发到 topic" />
      <CardBody>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Field
            label="topic"
            hint={presetTarget && presetTarget === topic.trim() ? "沿用消息页正在看的 topic" : undefined}
          >
            <ComboInput
              value={topic}
              choices={candidates}
              onValueChange={setTopic}
              placeholder="例如 orders.created"
              required
            />
          </Field>

          <Field label="key（可选）" hint="同 key 落到同一分区；空着则按 partitioner 轮询">
            <ComboInput
              value={key}
              choices={[]}
              onValueChange={setKey}
              placeholder="(无 key)"
            />
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
