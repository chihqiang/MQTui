import { useState } from "react";

import { Button, Field, Input, Modal } from "@/components/ui";
import { useResendMessage } from "@/hooks/use-message-disposal";
import type { MessageSummary } from "@/types";

interface Props {
  connectionId: string;
  message: MessageSummary;
  onClose: () => void;
}

/**
 * Kafka 消息重发确认框。
 *
 * 这里最要紧的一件事是把语义说对：**重发不是移动**。Kafka 的消息按 offset
 * 存在分区日志里，所谓重发只是往日志里再写一条，原消息一动不动。
 * 三处「留空即沿用」也都在提示里写明，避免用户以为清空输入就是「发一条空的」。
 */
export function MessageResendDialog({ connectionId, message, onClose }: Props) {
  const resend = useResendMessage(connectionId);

  const [topic, setTopic] = useState("");
  const [key, setKey] = useState("");
  const [payload, setPayload] = useState("");
  const [keepHeaders, setKeepHeaders] = useState(true);

  const submit = () => {
    resend.mutate(
      {
        connectionId,
        messageId: message.id,
        topic: topic.trim(),
        key: key.trim() || undefined,
        payload: payload.trim() ? payload : undefined,
        keepHeaders,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      title="重发消息"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" variant="primary" loading={resend.isPending} onClick={submit}>
            {resend.isPending ? "发送中…" : "再发一次"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-slate-500">
          会用下面的 key 和内容往日志里<strong className="text-slate-800">写一条新消息</strong>，
          原消息仍然留在分区 {message.partition ?? "-"} offset {message.offset ?? "-"} 上，不会被移走。
        </p>

        <dl className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
          <Meta label="原 topic" value={message.topic ?? "-"} />
          <Meta label="原分区 / offset" value={`${message.partition ?? "-"} / ${message.offset ?? "-"}`} />
          <Meta label="原 key" value={message.key ?? "(无)"} />
          <Meta label="原大小" value={message.size === undefined ? "-" : `${message.size} B`} />
        </dl>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="目标 topic" hint="留空沿用原 topic">
            <Input
              value={topic}
              onChange={(event) => setTopic(event.currentTarget.value)}
              placeholder={message.topic ?? "topic 名称"}
            />
          </Field>
          <Field label="消息 key" hint="留空沿用原 key；换 key 会让分区落点变掉">
            <Input
              value={key}
              onChange={(event) => setKey(event.currentTarget.value)}
              placeholder={message.key ?? "(无 key)"}
            />
          </Field>
        </div>

        <Field label="消息内容" hint="留空沿用原内容；首尾空白会被当成内容的一部分保留">
          <textarea
            value={payload}
            onChange={(event) => setPayload(event.currentTarget.value)}
            rows={5}
            placeholder={message.preview || "(原消息内容为空)"}
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-xs text-slate-800 shadow-xs outline-none placeholder:text-meta focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
          />
        </Field>

        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={keepHeaders}
            onChange={(event) => setKeepHeaders(event.currentTarget.checked)}
          />
          带上原消息的 headers
          <span className="text-slate-500">（trace-id 这类链路信息通常是排查的关键）</span>
        </label>
      </div>
    </Modal>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-(length:--text-app-meta) text-slate-500">{label}</dt>
      <dd className="truncate font-mono text-slate-800" title={value}>
        {value}
      </dd>
    </div>
  );
}
