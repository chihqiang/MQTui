import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button, Modal, SkeletonRows } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { formatBytes, formatNumber, formatTimestamp } from "@/lib/format";
import { IconCopy, IconSearch } from "@/lib/icons";
import { messageService, queryKeys } from "@/services";
import type { MessageSummary } from "@/types";

interface Props {
  connectionId: string;
  message: MessageSummary;
  onClose: () => void;
  /**
   * 「按这个 key 继续找」：把这条消息的 key 带回定位面板。
   *
   * 详情是排查的十字路口 —— 看到一条可疑消息，下一步十有八九是「同一个 key 的
   * 其它消息」。没有这个入口，用户得自己选中、复制、记住，切回定位面板再粘贴。
   * 只在 Kafka 侧传：AMQP 没有 key 的顺序扫描语义。
   */
  onLocateKey?: (key: string) => void;
}

/** 消息详情弹窗：payload + headers + 位点信息。 */
export function MessageDetailDialog({ connectionId, message, onClose, onLocateKey }: Props) {
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
            <Meta label="Topic" value={data.summary.topic ?? "-"} />
            <Meta label="Partition" value={formatNumber(data.summary.partition)} />
            <Meta label="Offset" value={formatNumber(data.summary.offset)} />
            <Meta label="大小" value={formatBytes(data.summary.size)} />
            <Meta label="时间" value={formatTimestamp(data.summary.timestamp)} />
            <Meta
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
        <Meta label="Topic" value={message.topic ?? "-"} />
        <Meta label="Partition" value={formatNumber(message.partition)} />
        <Meta label="Offset" value={formatNumber(message.offset)} />
        <Meta label="大小" value={formatBytes(message.size)} />
        <Meta label="时间" value={formatTimestamp(message.timestamp)} />
        <Meta
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

function Meta({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  /** 格子右上角的小动作。只有真的能顺手做点什么时才出现。 */
  action?: ReactNode;
}) {
  return (
    <div className="rounded border border-slate-200 px-2 py-1.5">
      <dt className="flex items-center gap-1 text-(length:--text-app-micro) uppercase tracking-wide text-secondary font-medium">
        <span className="min-w-0 truncate">{label}</span>
        {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      </dt>
      <dd className="truncate text-slate-800" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * 「按这个 key 继续找」。
 *
 * 点完要做三件事：把 key 交给定位面板、切到定位模式、关掉这个弹窗。
 * 三件事都发生在外面，这个按钮只负责说清「我带过去的是哪个 key」——
 * 排查时人一次开着好几个详情，按钮上写清楚 key 比只写「找这个 key」有用。
 */
function LocateKeyButton({
  messageKey,
  onLocateKey,
  onClose,
}: {
  messageKey: string;
  onLocateKey: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      icon={<IconSearch size={11} />}
      title={`把 key「${messageKey}」带进定位面板，顺序扫描这个 topic`}
      onClick={() => {
        onLocateKey(messageKey);
        onClose();
      }}
    >
      继续找
    </Button>
  );
}
