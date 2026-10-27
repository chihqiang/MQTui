import { useState } from "react";

import { Button, ComboInput, Field, Input, Modal } from "@/components/ui";
import { useResendMessage } from "@/hooks/use-message-disposal";
import type { MessageResendProps } from "@/types/message";


/**
 * Kafka 消息重发确认框。
 *
 * 这里最要紧的一件事是把语义说对：**重发不是移动**。Kafka 的消息按 offset
 * 存在分区日志里，所谓重发只是往日志里再写一条，原消息一动不动。
 * 三处「留空即沿用」也都在提示里写明，避免用户以为清空输入就是「发一条空的」。
 */
export function MessageResendDialog({ connectionId, message, onClose, topicNames }: MessageResendProps) {
  const resend = useResendMessage(connectionId);
  const [topic, setTopic] = useState("");
  const [key, setKey] = useState("");
  const [payload, setPayload] = useState("");
  const [keepHeaders, setKeepHeaders] = useState(true);
  /*
    重发到别的 topic 时，名字依旧是「已经存在的集合」——打错一个字母就是一条写进
    自动建出来的新主题的消息，下游永远收不到。所以默认只给选；
    没拿到主题列表时放开手输，否则这个弹窗在主题列表读失败时彻底不能用。
  */
  const strictTopic = topicNames !== null;

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
      <div className="flex flex-col gap-3 text-(length:--text-app-title)">
        <p className="text-(length:--text-app-body) text-slate-500">
          会用下面的 key 和内容往日志里<strong className="text-slate-800">写一条新消息</strong>，
          原消息仍然留在分区 {message.partition ?? "-"} offset {message.offset ?? "-"} 上，不会被移走。
        </p>

        <dl className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-(length:--text-app-body)">
          <Meta label="原 topic" value={message.topic ?? "-"} />
          <Meta label="原分区 / offset" value={`${message.partition ?? "-"} / ${message.offset ?? "-"}`} />
          <Meta label="原 key" value={message.key ?? "(无)"} />
          <Meta label="原大小" value={message.size === undefined ? "-" : `${message.size} B`} />
        </dl>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="目标 topic"
            hint={strictTopic ? "留空沿用原 topic" : "主题列表未读到，可直接手填；留空沿用原 topic"}
          >
            <ComboInput
              value={topic}
              choices={topicNames ?? []}
              strict={strictTopic}
              allowEmpty
              onValueChange={setTopic}
              placeholder={message.topic ?? "topic 名称"}
            />
          </Field>
          {/*
            key 不发候选：它不是「已存在的资源名」，而是一个业务值（订单号、用户 ID）。
            列表里唯一那个已知的 key 就是这条消息自己的，把它做成下拉只会诱人
            把重发做成「同一条再发一遍」。
          */}
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
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-(length:--text-app-body) text-slate-800 shadow-xs outline-none placeholder:text-meta focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15"
          />
        </Field>

        <label className="flex items-center gap-2 text-(length:--text-app-body) text-slate-600">
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
      <dt className="text-(length:--text-app-meta) text-meta">{label}</dt>
      <dd className="truncate font-mono text-slate-800" title={value}>
        {value}
      </dd>
    </div>
  );
}
