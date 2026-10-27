import { useEffect, useState } from "react";

import { Button, Field, Input, Modal } from "@/components/ui";
import { useDisconnectConsumer } from "@/hooks/use-consumer-disconnect";
import { confirmMatches, DISCONNECT_VERDICT_NOTE, evaluateDisconnect } from "@/lib/consumer-disconnect";
import type { QueueConsumption, QueueConsumer } from "@/types";

interface Props {
  connectionId: string | undefined;
  /** 待断开的消费者及其所属队列；为 `null` 时关闭弹窗。 */
  target: { queue: QueueConsumption; consumer: QueueConsumer } | null;
  onClose: () => void;
}

/**
 * 断开消费者的确认框。
 *
 * 断开不可撤销，也不会被服务端的安全约束挡住（不像删队列有 `if-empty`），
 * 所以这里的确认做得比其它写操作更重：把「谁、在哪、还有多少在途消息」先摆清楚，
 * 再要求用户手打队列名。
 */
export function ConsumerDisconnectModal({ connectionId, target, onClose }: Props) {
  const [confirm, setConfirm] = useState("");
  const disconnect = useDisconnectConsumer(connectionId);
  const queue = target?.queue;
  const consumer = target?.consumer;

  // 每次换目标都清空确认串：上一轮的输入不该替这一轮的用户做决定。
  useEffect(() => setConfirm(""), [consumer?.consumerTag]);

  if (!queue || !consumer) {
    return <Modal open={false} title="断开消费者" onClose={onClose} children={null} />;
  }

  const verdict = evaluateDisconnect(consumer);
  const matched = confirmMatches(queue.queue, confirm);
  const blocked = verdict !== "allowed";

  return (
    <Modal
      open={Boolean(consumer)}
      title="断开消费者"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={blocked || !matched || disconnect.isPending}
            onClick={() => {
              disconnect.mutate(
                { queue: queue.queue, consumerTag: consumer.consumerTag, confirm },
                { onSuccess: onClose },
              );
            }}
          >
            {disconnect.isPending ? "断开中…" : "断开"}
          </Button>
        </>
      }
    >
      {consumer ? (
        <div className="flex flex-col gap-3 text-(length:--text-app-body)">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Item label="队列" value={queue.queue} />
            <Item label="消费者标签" value={consumer.consumerTag} />
            <Item label="连接" value={consumer.connectionName ?? "—"} />
            <Item label="账号" value={consumer.username || "—"} />
            <Item label="预取" value={consumer.prefetchCount === 0 ? "不限" : String(consumer.prefetchCount)} />
            <Item label="未确认" value={String(consumer.messagesUnacknowledged)} />
          </dl>

          <p
            className={
              blocked ? "rounded border border-amber-500/40 px-3 py-2 text-amber-800" : "text-slate-500"
            }
          >
            {DISCONNECT_VERDICT_NOTE[verdict]}
          </p>

          {/* 不允许断开时不给输入框：填了也点不动，只会让人困惑。 */}
          {blocked ? null : (
            <Field label={`输入队列名 ${queue.queue} 以确认`}>
              <Input
                value={confirm}
                autoFocus
                placeholder={queue.queue}
                onChange={(event) => setConfirm(event.currentTarget.value)}
              />
            </Field>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-(length:--text-app-meta) text-meta">{label}</dt>
      <dd className="break-all font-mono text-slate-800">{value}</dd>
    </div>
  );
}
