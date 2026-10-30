import { useMemo, useState } from "react";

import {
  Card,
  CardHeader,
  ComboInput,
  Field,
  Input,
  SectionTitle,
  Textarea,
} from "@/components/ui";
import { HeaderEditor } from "@/components/broker/header-editor";
import { ProduceResultRow, type ProduceResult } from "@/components/broker/produce-result";
import { ProduceSendBar, submitShortcutLabel } from "@/components/broker/produce-send-bar";
import { useTopics } from "@/hooks/use-broker-data";
import { messageService } from "@/services";
import { listRecentTargets, connectionMemoryKey } from "@/lib/workspace-storage";
import { messagesPath } from "@/lib/actions";
import { errorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  changedOptionCount,
  kafkaKey,
  payloadBytes,
  sendBlockers,
  toHeaders,
  type HeaderRow,
} from "@/lib/produce";
import type { ConnectionSummary } from "@/types";

/**
 * Kafka 发送表单：topic、key、headers、payload。
 *
 * 版式按「发送页」该有的样子排：
 * - 首屏只有两格必填 —— 目标（topic + key）与正文，其余收进「高级选项」；
 * - 发送条常驻卡片底部：能发时说数据量，不能发时说**为什么不**，不用滚回去找；
 * - 结果留在页面上（字节数、时间、「查看这条消息」），不再只靠一闪而过的 toast；
 * - `⌘/Ctrl + ↵` 直接发送 —— 写消息的人手本来就在键盘上。
 *
 * 「共用一张表单 + 隐藏不适用的格子」试过，结论是不划算：
 * Kafka 没有交换机、也没有 AMQP 的投递模式与内容类型，
 * 留着它们只能是几个永远置灰的框，还要在提示里解释「这一格你不用管」。
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
  const [topic, setTopic] = useState(presetTarget ?? "");
  const [key, setKey] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [payload, setPayload] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ProduceResult | null>(null);

  const { data: topics } = useTopics(connectionId, true);
  const candidates = useMemo(() => {
    const recent = listRecentTargets(connectionMemoryKey(connection.kind, connection.endpoint));
    return [...new Set([...recent, ...(topics ?? []).map((item) => item.name)])];
  }, [connection.kind, connection.endpoint, topics]);

  const bytes = payloadBytes(payload);
  const blocked = sendBlockers({ kind: "kafka", topic, payload });
  const changedOptions = changedOptionCount({ kind: "kafka", headers: rows });
  const shortcut = submitShortcutLabel();

  const send = async () => {
    // 快捷键与按钮走同一条路：判两次迟早会有一处忘了判。
    if (blocked || submitting) return;
    const sentBytes = payloadBytes(payload);
    const topicName = topic.trim();
    setSubmitting(true);
    try {
      const outcome = await messageService.sendMessage({
        kind: "kafka",
        connectionId,
        topic: topicName,
        key: kafkaKey(key),
        headers: toHeaders(rows),
        payload,
      });
      setResult({
        // 没拿到确认时既不能报「已写入」（那是替服务端保证），
        // 也不能报「失败」（会招来一次重复发送）。两种说法都错，所以单列一档。
        tone: outcome.unsure ? "warning" : "success",
        title: outcome.unsure ? "没拿到写入确认" : `已写入 topic ${topicName}`,
        detail: outcome.unsure ? outcome.detail : outcome.producerWarning,
        bytes: sentBytes,
        at: Date.now(),
        viewPath: messagesPath(connectionId, topicName),
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
      <CardHeader title="发到 topic" />
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
            左右分栏：左边是「这条消息是什么」（必填，宽），右边是「附加属性」（窄）。
            分栏比折叠更直接 —— 高级项一直在，但一眼就知道它不在主线上；
            折叠起来的东西，下次进来还得再点开确认一遍有没有改过。
          */}
          <div className="grid grid-cols-1 items-start gap-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex min-w-0 flex-col gap-3 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
                <Field
                  label="topic"
                  hint={
                    presetTarget && presetTarget === topic.trim()
                      ? "沿用消息页正在看的 topic"
                      : undefined
                  }
                >
                  <ComboInput
                    value={topic}
                    choices={candidates}
                    onValueChange={setTopic}
                    placeholder="例如 orders.created"
                    required
                  />
                </Field>

                <Field label="key（可选）" hint="同 key 落到同一分区；空着按 partitioner 分配">
                  {/*
                    这里刻意不是下拉：key 是业务值（订单号），不是这台机器上已有的资源名。
                    给一个空候选的下拉，等于把一个普通输入框画成「看着能展开、点开是空的」坏控件。
                  */}
                  <Input
                    value={key}
                    onChange={(event) => setKey(event.currentTarget.value)}
                    placeholder="(无 key)"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label="Payload" hint="原样发送，不做格式化">
                <Textarea
                  rows={12}
                  value={payload}
                  onChange={(event) => setPayload(event.currentTarget.value)}
                  placeholder={'{"orderId":"A-1024"}'}
                  className="leading-relaxed"
                  required
                />
              </Field>

              {result ? (
                <ProduceResultRow
                  result={result}
                  onClear={() => {
                    // 目标与高级选项保留：接着发下一条时，通常只换正文。
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
              <HeaderEditor
                rows={rows}
                onChange={setRows}
                hint="record headers：trace-id 这类链路信息放这里；key 空着的行不会发送"
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
