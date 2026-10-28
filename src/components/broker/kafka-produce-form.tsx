import { useMemo, useState } from "react";

import { Button, Card, CardBody, CardHeader, ComboInput, Field, Textarea } from "@/components/ui";
import { HeaderEditor } from "@/components/broker/header-editor";
import { useTopics } from "@/hooks/use-broker-data";
import { messageService } from "@/services";
import { useSessionStore } from "@/stores";
import { listRecentTargets, connectionMemoryKey } from "@/lib/workspace-storage";
import { errorMessage } from "@/lib/errors";
import { kafkaKey, sendBlockers, toHeaders, type HeaderRow } from "@/lib/produce";
import type { ConnectionSummary } from "@/types";

/**
 * Kafka 发送表单：topic、key、headers、payload。
 *
 * 「共用一张表单 + 隐藏不适用的格子」试过，结论是不划算：
 * Kafka 没有交换机、也没有 AMQP 的投递模式与内容类型，
 * 留着它们只能是几个永远置灰的框，还要在提示里解释「这一格你不用管」。
 *
 * headers 例外 —— 它是两种协议都有的一项（Kafka 的 record headers /
 * AMQP 的 field table）。之前这一格根本没做，后端命令层也没接，
 * 于是「填了 trace-id，消费端看不到」：链路追踪断在第一跳。
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
  const [rows, setRows] = useState<HeaderRow[]>([]);
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
        headers: toHeaders(rows),
        payload,
      });
      // 没拿到确认时不报「已写入」：那句话会让人以为可以放心进入下一步，
      // 而真实状态是「不知道」，要先刷新看一眼。
      pushToast(
        outcome.unsure ? "error" : "success",
        outcome.unsure ? outcome.detail : `已写入 topic ${topic.trim()}：${outcome.detail}`,
      );
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
            {/*
              这里刻意不给候选：key 是业务值（订单号），不是这台上已有的资源名。
              列表里唯一已知的就是「当前这条消息自己的 key」，做成下拉等于引诱人
              把「再发一条」误操作成「同一条再发一遍」。
            */}
            <ComboInput
              value={key}
              choices={[]}
              onValueChange={setKey}
              placeholder="(无 key)"
            />
          </Field>

          <HeaderEditor
            rows={rows}
            onChange={setRows}
            hint="record headers：trace-id 这类链路信息放这里；key 空着的行不会发送"
          />

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
