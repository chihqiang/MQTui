import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { Button, Card, CardBody, CardHeader, Field, Input, Textarea } from "@/components/ui";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { useSessionStore } from "@/stores";
import { useQueues, useTopics } from "@/hooks/use-broker-data";
import { useConnections } from "@/hooks/use-connections";
import { errorMessage } from "@/lib/errors";
import { connectionMemoryKey, listRecentTargets } from "@/lib/workspace-storage";
import { messageService } from "@/services";

/**
 * 发送消息：Kafka 发到 topic，RabbitMQ 发到 exchange + routing key。
 *
 * 目标名不让人重敲：列表页的「查看消息」已经带着 `?target=` 了，这一页也认同一个参数，
 * 于是「在消息页看着某条 topic 的消息，想往它发一条」是零输入的 —— 侧栏切过来就带着。
 * 没带参数时退回这台连接最近看过的 topic / queue，再退一步才是完整下拉。
 */
export function ProducePage() {
  const connectionId = useSessionStore((state) => state.activeConnectionId);
  const pushToast = useSessionStore((state) => state.pushToast);
  const [searchParams] = useSearchParams();
  const { data: connections } = useConnections();
  const connection = connections?.find((item) => item.id === connectionId);
  const isKafka = connection?.kind === "kafka";

  // 候选分批到：最近看过的排最前，完整的元数据列表跟在后面（支持手输不在列表里的名字）。
  const { data: topics } = useTopics(connectionId ?? undefined, Boolean(isKafka));
  const { data: queues } = useQueues(connectionId ?? undefined, connection?.kind === "rabbitMq");
  const candidates = useMemo(() => {
    const recent =
      connection && connectionId
        ? listRecentTargets(connectionMemoryKey(connection.kind, connection.endpoint))
        : [];
    const all = isKafka ? (topics ?? []).map((item) => item.name) : (queues ?? []).map((item) => item.name);
    return [...new Set([...recent, ...all])];
  }, [connection, connectionId, isKafka, topics, queues]);

  const [target, setTarget] = useState("");
  const [exchange, setExchange] = useState("");
  const [key, setKey] = useState("");
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 从消息页带着 `?target=` 过来时直接预填：那是用户刚刚在看的东西。
  // 只在参数变化时覆盖，不跟着每次输入重设 —— 否则用户改完名字又被打回原样。
  const preset = searchParams.get("target");
  useEffect(() => {
    if (preset) setTarget(preset);
  }, [preset]);

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

  const targetField = isKafka ? "topic" : "routing key";
  /** 预填值与当前值一致时说明一句来源：否则用户会以为自己上次填的还在。 */
  const inherited = preset !== null && preset === target;

  return (
    <PageBody>
      <PageHeader
        title="发送消息"
        description="投递一条消息用于验证；payload 原样发送，不做格式化"
      />

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
              <Field label={`目标（${targetField}）`} hint={inherited ? "沿用消息页正在看的目标" : undefined}>
                <Input
                  value={target}
                  onChange={(event) => setTarget(event.currentTarget.value)}
                  list="produce-targets"
                  placeholder="例如 orders.created"
                  required
                />
                <datalist id="produce-targets">
                  {candidates.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
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
              <Button type="submit" loading={submitting}>
                发送
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </PageBody>
  );
}
