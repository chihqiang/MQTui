import { useQuery } from "@tanstack/react-query";

import { Button, Modal, SkeletonRows } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import { IconCopy } from "@/lib/icons";
import { messageService, queryKeys } from "@/services";
import type { MessageSummary } from "@/types";

interface Props {
  connectionId: string;
  message: MessageSummary;
  onClose: () => void;
}

/** 消息详情弹窗：payload + headers + 位点信息。 */
export function MessageDetailDialog({ connectionId, message, onClose }: Props) {
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
        <InlineDetail message={message} payload={inlinePayload} />
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
            <Meta label="Topic" value={data.summary.topic ?? "-"} />
            <Meta label="Partition" value={formatNumber(data.summary.partition)} />
            <Meta label="Offset" value={formatNumber(data.summary.offset)} />
            <Meta label="大小" value={formatBytes(data.summary.size)} />
            <Meta label="时间" value={formatTimestamp(data.summary.timestamp)} />
            <Meta label="Key" value={data.summary.key ?? "-"} />
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
function InlineDetail({ message, payload }: { message: MessageSummary; payload: string }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-2 text-(length:--text-app-body) sm:grid-cols-4">
        <Meta label="Topic" value={message.topic ?? "-"} />
        <Meta label="Partition" value={formatNumber(message.partition)} />
        <Meta label="Offset" value={formatNumber(message.offset)} />
        <Meta label="大小" value={formatBytes(message.size)} />
        <Meta label="时间" value={formatTimestamp(message.timestamp)} />
        <Meta label="Key" value={message.key ?? "-"} />
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

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5">
      <dt className="text-(length:--text-app-micro) uppercase tracking-wide text-secondary font-medium">{label}</dt>
      <dd className="truncate text-slate-800">{value}</dd>
    </div>
  );
}
