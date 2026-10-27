import { useState } from "react";

import { Badge, Button, Field, Input, Modal } from "@/components/ui";
import {
  useBatchDisposeMessages,
  useRetryStrandedMessages,
} from "@/hooks/use-message-disposal";
import { canRetryStranded, strandedRetryRequest } from "@/lib/stranded";
import { MAX_BATCH_SIZE, type BatchDisposalItem, type DisposalAction, type MessageSummary } from "@/types";

interface Props {
  connectionId: string;
  /** 选中的消息，顺序即回报顺序。 */
  messages: MessageSummary[];
  action: DisposalAction;
  onClose: () => void;
  /** 有消息真的被处置成功时回调，让列表把这几行从选中集里摘掉。 */
  onDisposed: (messageIds: string[]) => void;
}

/**
 * 批量处置确认框。
 *
 * 与单条处置的差别不在界面，而在**结果怎么给**：
 * 批量操作不可回滚，一条失败就该停下，所以结果必须逐条铺开，
 * 让「哪几条已经离开队列、哪几条还在」一眼可见。
 */
export function MessageBatchDisposalDialog({
  connectionId,
  messages,
  action,
  onClose,
  onDisposed,
}: Props) {
  const batch = useBatchDisposeMessages(connectionId);
  const retry = useRetryStrandedMessages(connectionId);
  const [exchange, setExchange] = useState("");
  const [routingKey, setRoutingKey] = useState("");

  // 重试跑完之后以重试结果为准：它才是「现在还剩几条卡住」。
  const outcome = retry.data ?? batch.data;
  const tooMany = messages.length > MAX_BATCH_SIZE;
  const queue = messages[0]?.topic ?? "-";

  const stranded = outcome?.stranded ?? [];
  const showRetry = canRetryStranded(outcome);
  const retryStranded = () => {
    // 原样递回上一轮结果里的那批 ID：它们是用户没选中的消息，
    // 不该按「现在选中的那几条」重算 —— 选中集早就清空了。
    const payload = strandedRetryRequest(outcome, {
      action,
      queue,
      exchange: exchange.trim(),
      routingKey: routingKey.trim(),
    });
    if (payload) retry.mutate(payload);
  };

  const submit = () => {
    batch.mutate(
      {
        action,
        messageIds: messages.map((message) => message.id),
        exchange: exchange.trim(),
        routingKey: routingKey.trim(),
      },
      {
        onSuccess: (result) => {
          const done = result.items
            .filter((item) => item.status === "ok")
            .map((item) => item.messageId);
          if (done.length) onDisposed(done);
        },
      },
    );
  };

  return (
    <Modal
      open
      title={action === "redeliver" ? `批量重新投递 · ${messages.length} 条` : `批量移入死信 · ${messages.length} 条`}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {outcome ? "关闭" : "取消"}
          </Button>
          {showRetry ? (
            <Button size="sm" variant="secondary" loading={retry.isPending} onClick={retryStranded}>
              重试这批放回（{stranded.length} 条）
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={action === "deadLetter" ? "danger" : "primary"}
            disabled={batch.isPending || tooMany || Boolean(batch.data)}
            onClick={submit}
          >
            {batch.isPending ? "处理中…" : "确认执行"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-(length:--text-app-title)">
        <p className="text-(length:--text-app-body) text-slate-500">
          逐条串行执行：先发布并等确认，落地之后才让原消息从队列消失。
          <span className="text-amber-700">中途有一条失败就停下</span>
          ，剩下的原样留在队列里——不做半截处置。
        </p>

        <dl className="grid grid-cols-3 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-(length:--text-app-body)">
          <Meta label="队列" value={queue} />
          <Meta label="条数" value={String(messages.length)} />
          <Meta label="上限" value={`${MAX_BATCH_SIZE} 条`} />
        </dl>

        {tooMany ? (
          <p className="text-(length:--text-app-body) text-amber-700">
            一次最多处置 {MAX_BATCH_SIZE} 条，请分批操作
          </p>
        ) : null}

        {!outcome && action === "redeliver" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="目标交换机" hint="留空表示默认交换机（按队列名直接投递）">
              <Input
                value={exchange}
                onChange={(event) => setExchange(event.currentTarget.value)}
                placeholder="例如 orders.exchange"
              />
            </Field>
            <Field label="目标 routing key" hint="留空则每条沿用各自的原始 routing key">
              <Input
                value={routingKey}
                onChange={(event) => setRoutingKey(event.currentTarget.value)}
                placeholder="留空即原路重走"
              />
            </Field>
          </div>
        ) : null}

        {batch.error ? (
          <p className="text-(length:--text-app-body) text-rose-700">
            整批未执行：{batch.error instanceof Error ? batch.error.message : String(batch.error)}
          </p>
        ) : null}

        {retry.error ? (
          <p className="text-(length:--text-app-body) text-rose-700">
            重试未执行：
            {retry.error instanceof Error ? retry.error.message : String(retry.error)}
          </p>
        ) : null}

        {outcome ? (
          <OutcomeTable
            note={outcome.note}
            items={outcome.items}
            stranded={stranded}
            retryable={outcome.retryable}
          />
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * 逐条结果。成功的和没成功的都要出现，跳过的那几条尤其不能省。
 *
 * `stranded` 单独一段：它统计的是用户**没有**选中的消息，
 * 落在逐条列表里会让人以为「我没选它，怎么出现在结果里」。
 *
 * 卡住的那些要列到 ID 一级。只报个数字，用户除了干等连接关闭什么也做不了 ——
 * 而这个数字意味着「我没选它们，它们却可能没回到队列」。
 */
function OutcomeTable({
  note,
  items,
  stranded,
  retryable,
}: {
  note: string;
  items: BatchDisposalItem[];
  stranded: string[];
  retryable?: boolean;
}) {
  const failed = items.some((item) => item.status !== "ok");
  return (
    <div className="flex flex-col gap-2">
      <p className={failed ? "text-(length:--text-app-body) text-amber-700" : "text-(length:--text-app-body) text-emerald-700"}>{note}</p>
      {stranded.length ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-(length:--text-app-body) text-amber-800">
          <p>
            另有 <span className="tabular">{stranded.length}</span> 条顺带取出的消息未能放回队列，
            仍被本次消费通道持有。
          </p>
          <p className="mt-1 text-(length:--text-app-meta) text-amber-800/80">
            {retryable
              ? "点「重试这批放回」再放一次；通道关闭前它们不会自己回去。"
              : "该连接不支持重试放回：重新打开队列查看即可让服务端退回，或稍后重试。"}
          </p>
          <ul className="mt-1 max-h-24 overflow-auto font-mono text-(length:--text-app-meta)">
            {stranded.map((id) => (
              <li key={id} className="truncate" title={id}>
                {id}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="max-h-64 overflow-auto rounded-md border border-slate-200">
        {items.map((item) => (
          <li
            key={item.messageId}
            className="flex items-start gap-2 border-b border-slate-200 px-2 py-1.5 text-(length:--text-app-body) last:border-b-0"
          >
            <StatusBadge status={item.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-slate-600" title={item.messageId}>
                {item.messageId}
              </span>
              <span className="block text-(length:--text-app-meta) text-slate-500">{item.detail || "-"}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: BatchDisposalItem["status"] }) {
  const map = {
    ok: { tone: "success", label: "成功" },
    failed: { tone: "danger", label: "失败" },
    skipped: { tone: "warning", label: "跳过" },
  } as const;
  const { tone, label } = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-(length:--text-app-meta) text-meta">{label}</dt>
      <dd className="truncate font-mono text-slate-800" title={value}>
        {value}
      </dd>
    </div>
  );
}
