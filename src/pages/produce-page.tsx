import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ComboInput,
  Field,
  Textarea,
} from "@/components/ui";
import { useTopology } from "@/hooks/use-broker-data";
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

  const [target, setTarget] = useState("");
  const [exchange, setExchange] = useState("");
  const [key, setKey] = useState("");
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 候选分批到：最近看过的排最前，完整的元数据列表跟在后面（支持手输不在列表里的名字）。
  const { data: topics } = useTopics(connectionId ?? undefined, Boolean(isKafka));
  const { data: queues } = useQueues(connectionId ?? undefined, connection?.kind === "rabbitMq");
  // RabbitMQ 侧的 exchange 与 routing key 也来自拓扑：发消息最常踩的坑是把
  // `order.created` 敲成 `order.create`，然后对着「发出去了但没人收到」发呆。
  const { data: topology } = useTopology(connectionId ?? undefined, connection?.kind === "rabbitMq");
  const candidates = useMemo(() => {
    const recent =
      connection && connectionId
        ? listRecentTargets(connectionMemoryKey(connection.kind, connection.endpoint))
        : [];
    const all = isKafka ? (topics ?? []).map((item) => item.name) : (queues ?? []).map((item) => item.name);
    return [...new Set([...recent, ...all])];
  }, [connection, connectionId, isKafka, topics, queues]);
  const exchangeChoices = useMemo(
    () =>
      (topology?.exchanges ?? [])
        .filter((item) => item.name)
        .map((item) => ({ value: item.name, hint: item.exchangeType })),
    [topology],
  );
  // routing key 候选跟着填好的 exchange 走；exchange 空着时给全部——那时用户还没决定往哪发。
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
                {/*
                  目标框原来是 `<datalist>`：候选能弹，但只有「当前输入的子串」
                  命中的那几条，且样式跟随系统。换成自绘下拉之后，点箭头能直接看到
                  最近看过的目标 —— 「去这个 topic 发一条」本来就不该靠打字。
                */}
                <ComboInput
                  value={target}
                  choices={candidates}
                  onValueChange={setTarget}
                  placeholder="例如 orders.created"
                  required
                />
              </Field>
              {/*
                Kafka 不用交换机，这一格以前存在但填了没用。不隐藏而是置灰：
                两种中间件共用一张表单，藏掉会让表单在两个连接之间「长得不一样」。
              */}
              <Field
                label="Exchange（仅 RabbitMQ）"
                hint={isKafka ? "Kafka 不使用交换机" : "留空表示默认交换机"}
              >
                <ComboInput
                  value={exchange}
                  choices={exchangeChoices}
                  disabled={isKafka}
                  onValueChange={setExchange}
                  placeholder={isKafka ? "-" : "orders.exchange"}
                />
              </Field>
            </div>

            <Field
              label={isKafka ? "Key（可选）" : "routing key（可选）"}
              hint={
                isKafka
                  ? "同 key 落到同一分区；空着则轮询"
                  : "候选取自已有绑定；空着按队列名直投默认交换机"
              }
            >
              <ComboInput
                value={key}
                choices={isKafka ? [] : keyChoices}
                onValueChange={setKey}
                placeholder={isKafka ? "(无 key)" : "order.created"}
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
