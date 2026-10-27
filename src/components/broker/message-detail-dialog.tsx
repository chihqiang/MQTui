import { useQuery } from "@tanstack/react-query";

import { Button, MetaItem, Modal, SkeletonRows } from "@/components/ui";
import { LocateKeyButton } from "@/components/broker";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import { IconCopy } from "@/lib/icons";
import { messageService, queryKeys } from "@/services";
import type { MessageDetailProps, MessageSummary } from "@/types";


/** 消息详情弹窗：payload + headers + 位点信息。 */
export function MessageDetailDialog({ connectionId, message, onClose, onLocateKey }: MessageDetailProps) {
  const messageId = message.id;
  // 列表已经带回 payload（RabbitMQ）时不再回源：AMQP 的 deliveryTag 在 requeue 后会变，
  // 回源要么查不到，要么读到另一条消息。
  const inlinePayload = message.payload;
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.message(connectionId, messageId),
    queryFn: () => messageService.getMessage(connectionId, messageId),
    enabled: inlinePayload === undefined,
  });

  if (inlinePayload !== undefined) {
    return (
      <Modal open title="消息详情" onClose={onClose}>
        <InlineDetail message={message} payload={inlinePayload} onLocateKey={onLocateKey} onClose={onClose} />
      </Modal>
    );
  }

  return (
    <Modal open title="消息详情" onClose={onClose}>
      {/* 骨架与真实内容同形：详情弹窗打开时列表还在后面，跳版会让人以为点错了行。 */}
      {isLoading ? <SkeletonRows rows={5} className="p-0" label="读取详情…" /> : null}
      {error ? <p className="text-(length:--text-app-title) text-rose-700">{errorMessage(error)}</p> : null}

      {data ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-2 text-(length:--text-app-body) sm:grid-cols-4">
            <MetaItem label="Topic" value={data.summary.topic ?? "-"} />
            <MetaItem label="Partition" value={formatNumber(data.summary.partition)} />
            <MetaItem label="Offset" value={formatNumber(data.summary.offset)} />
            <MetaItem label="大小" value={formatBytes(data.summary.size)} />
            <MetaItem label="时间" value={formatTimestamp(data.summary.timestamp)} />
            <MetaItem
              label="Key"
              value={data.summary.key ?? "-"}
              action={
                data.summary.key && onLocateKey ? (
                  <LocateKeyButton
                    messageKey={data.summary.key}
                    onLocateKey={onLocateKey}
                    onClose={onClose}
                  />
                ) : undefined
              }
            />
          </dl>

          <PayloadSection payload={data.payload} note={data.payloadBase64 ? "内容不是合法 UTF-8，已显示 base64 原文" : undefined} tone="warning" />

          {data.headers.length > 0 ? (
            <section>
              <h4 className="mb-1 text-(length:--text-app-body) text-slate-500">Headers</h4>
              <ul className="flex flex-col gap-1">
                {data.headers.map((header, index) => (
                  <li
                    key={`${header.key}-${index}`}
                    className="flex gap-2 rounded border border-slate-200 px-2 py-1 text-(length:--text-app-body)"
                  >
                    <span className="shrink-0 font-mono text-info">{header.key}</span>
                    <span className="min-w-0 flex-1 break-all text-slate-600">{header.value}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

/** 列表已带 payload 时的详情视图：没有 headers，只展示能拿到的信息。 */
function InlineDetail({
  message,
  payload,
  onLocateKey,
  onClose,
}: {
  message: MessageSummary;
  payload: string;
  onLocateKey?: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-2 text-(length:--text-app-body) sm:grid-cols-4">
        <MetaItem label="Topic" value={message.topic ?? "-"} />
        <MetaItem label="Partition" value={formatNumber(message.partition)} />
        <MetaItem label="Offset" value={formatNumber(message.offset)} />
        <MetaItem label="大小" value={formatBytes(message.size)} />
        <MetaItem label="时间" value={formatTimestamp(message.timestamp)} />
        <MetaItem
          label="Key"
          value={message.key ?? "-"}
          action={
            message.key && onLocateKey ? (
              <LocateKeyButton messageKey={message.key} onLocateKey={onLocateKey} onClose={onClose} />
            ) : undefined
          }
        />
      </dl>

      <PayloadSection
        payload={payload}
        note="内容来自列表拉取，队列消息在读取后已放回，再次拉取可能读到不同的 messageId。"
      />
    </div>
  );
}


/**
 * 正文区：标题栏带一个复制键。
 *
 * 排查时最常见的一步是「把这条 JSON 贴给同事 / 贴进 jq」，选中再右键复制
 * 在这套壳里要多两次操作；复制键也顺手把「复制的是不是完整内容」这件事说清了
 * —— base64 兜底时复制到的就是看到的原文。
 */
function PayloadSection({
  payload,
  note,
  tone = "muted",
}: {
  payload: string;
  note?: string;
  tone?: "muted" | "warning";
}) {
  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-(length:--text-app-body) text-slate-500">Payload</h4>
        <Button
          size="xs"
          variant="ghost"
          icon={<IconCopy size={12} />}
          disabled={!payload}
          onClick={() => void navigator.clipboard?.writeText(payload)}
          title="复制完整正文"
        >
          复制
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded border border-slate-200 bg-white p-3 text-(length:--text-app-body) whitespace-pre-wrap break-all text-slate-800">
        {payload || "(空)"}
      </pre>
      {note ? (
        <p
          className={
            tone === "warning" ? "mt-1 text-(length:--text-app-meta) text-amber-700" : "mt-1 text-(length:--text-app-meta) text-slate-500"
          }
        >
          {note}
        </p>
      ) : null}
    </section>
  );
}
