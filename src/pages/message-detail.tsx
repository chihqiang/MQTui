import { useQuery } from "@tanstack/react-query";

import { Loading, Modal } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
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
      {isLoading ? <Loading label="读取详情…" /> : null}
      {error ? <p className="text-sm text-rose-300">{errorMessage(error)}</p> : null}

      {data ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Meta label="Topic" value={data.summary.topic ?? "-"} />
            <Meta label="Partition" value={formatNumber(data.summary.partition)} />
            <Meta label="Offset" value={formatNumber(data.summary.offset)} />
            <Meta label="大小" value={formatBytes(data.summary.size)} />
            <Meta label="时间" value={formatTimestamp(data.summary.timestamp)} />
            <Meta label="Key" value={data.summary.key ?? "-"} />
          </dl>

          <section>
            <h4 className="mb-1 text-xs text-slate-400">Payload</h4>
            <pre className="max-h-72 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-xs whitespace-pre-wrap break-all text-slate-200">
              {data.payload || "(空)"}
            </pre>
            {data.payloadBase64 ? (
              <p className="mt-1 text-[11px] text-amber-300">
                内容不是合法 UTF-8，已显示 base64 原文
              </p>
            ) : null}
          </section>

          {data.headers.length > 0 ? (
            <section>
              <h4 className="mb-1 text-xs text-slate-400">Headers</h4>
              <ul className="flex flex-col gap-1">
                {data.headers.map((header, index) => (
                  <li
                    key={`${header.key}-${index}`}
                    className="flex gap-2 rounded border border-slate-800 px-2 py-1 text-xs"
                  >
                    <span className="shrink-0 font-mono text-sky-300">{header.key}</span>
                    <span className="min-w-0 flex-1 break-all text-slate-300">{header.value}</span>
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
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Meta label="Topic" value={message.topic ?? "-"} />
        <Meta label="Partition" value={formatNumber(message.partition)} />
        <Meta label="Offset" value={formatNumber(message.offset)} />
        <Meta label="大小" value={formatBytes(message.size)} />
        <Meta label="时间" value={formatTimestamp(message.timestamp)} />
        <Meta label="Key" value={message.key ?? "-"} />
      </dl>

      <section>
        <h4 className="mb-1 text-xs text-slate-400">Payload</h4>
        <pre className="max-h-72 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-xs whitespace-pre-wrap break-all text-slate-200">
          {payload || "(空)"}
        </pre>
        <p className="mt-1 text-[11px] text-slate-500">
          内容来自列表拉取，队列消息在读取后已放回，再次拉取可能读到不同的 messageId。
        </p>
      </section>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-800 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="truncate text-slate-200">{value}</dd>
    </div>
  );
}
