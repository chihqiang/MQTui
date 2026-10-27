import { useState } from "react";

import { Button, ComboInput, Field, Modal } from "@/components/ui";
import { useDeadLetterMessage, useDisposalCapabilities, useRedeliverMessage } from "@/hooks/use-message-disposal";
import type { MessageSummary } from "@/types";

/** 处置动作：重投到别的交换机，或交给队列声明的死信交换机。 */
type Action = "redeliver" | "deadLetter";

interface Props {
  connectionId: string;
  message: MessageSummary;
  action: Action;
  onClose: () => void;
  /**
   * 拓扑里确切的交换机名。解析失败时传 `null`，目标交换机退回自由输入 ——
   * 这时候如果还硬做完备性校验，第一个被弹回去的就是用户真正想填的那个名字。
   */
  exchangeNames: string[] | null;
  /** 同上：全局去重后的 routing key。 */
  routingKeys: string[] | null;
}

/**
 * 消息处置确认框。
 *
 * 两个动作都不可撤销，所以都要先在弹窗里把「这条会去哪」写清楚再让用户点确认：
 * 重投要填目标交换机与 routing key，死信则把队列声明的目标原样展示出来。
 */
export function MessageDisposalDialog({
  connectionId,
  message,
  action,
  onClose,
  exchangeNames,
  routingKeys,
}: Props) {
  const { data: capabilities, isLoading } = useDisposalCapabilities(connectionId, message.id, true);
  /*
    重投的两个空格都指向「已经存在的名字」，所以默认不让自由输入：
    打错一个字就是一条投出去没人收的消息，而且不报错。
    但红投本身是救火动作 —— 拓扑没读到、或目标交换机是刚在别处建的，
    这时候还坚持「只能选列表里的」会把唯一的出路堵死，于是 `strict` 跟着数据有无走。
  */
  const strictExchange = exchangeNames !== null;
  const strictKey = routingKeys !== null;
  const redeliver = useRedeliverMessage(connectionId);
  const deadLetter = useDeadLetterMessage(connectionId);

  // 重投默认回到消息来源交换机，routing key 留空表示沿用原始 routing key。
  const [exchange, setExchange] = useState("");
  const [routingKey, setRoutingKey] = useState("");
  const pending = redeliver.isPending || deadLetter.isPending;

  const reason = capabilities?.reasons?.find((item) => item.key === action)?.value;
  const blocked = action === "deadLetter" && capabilities && !capabilities.canDeadLetter;

  const submit = () => {
    const close = () => {
      redeliver.reset();
      deadLetter.reset();
      onClose();
    };
    if (action === "redeliver") {
      redeliver.mutate(
        { connectionId, messageId: message.id, exchange: exchange.trim(), routingKey: routingKey.trim() },
        { onSuccess: close },
      );
      return;
    }
    deadLetter.mutate({ connectionId, messageId: message.id }, { onSuccess: close });
  };

  return (
    <Modal
      open
      title={action === "redeliver" ? "重新投递消息" : "移入死信"}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            variant={action === "deadLetter" ? "danger" : "primary"}
            disabled={pending || isLoading || Boolean(blocked)}
            onClick={submit}
          >
            {pending ? "处理中…" : "确认执行"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-(length:--text-app-title)">
        <p className="text-(length:--text-app-body) text-slate-500">
          {action === "redeliver"
            ? "会先发布一份到目标交换机，确认落地之后才让原消息从队列里消失。发布失败时原消息留在队列，不会丢。"
            : "会把这条消息发布到队列声明的死信交换机，然后从当前队列移除。这一步不可撤销。"}
        </p>

        <dl className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-(length:--text-app-body)">
          <Meta label="队列" value={message.topic ?? "-"} />
          <Meta label="投递标签" value={String(message.offset ?? "-")} />
          <Meta label="大小" value={message.size === undefined ? "-" : `${message.size} B`} />
          <Meta label="Payload" value={message.preview || "(空)"} />
        </dl>

        {reason ? <p className="text-(length:--text-app-body) text-amber-700">{reason}</p> : null}

        {action === "redeliver" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="目标交换机"
              hint={
                strictExchange
                  ? "留空表示默认交换机（按队列名直接投递）"
                  : "拓扑未读到，可直接手填交换机名；留空表示默认交换机"
              }
            >
              <ComboInput
                value={exchange}
                choices={exchangeNames ?? []}
                strict={strictExchange}
                allowEmpty
                onValueChange={setExchange}
                placeholder="例如 orders.exchange"
              />
            </Field>
            <Field
              label="目标 routing key"
              hint={
                strictKey
                  ? "候选取自已有绑定；留空沿用消息的原始 routing key"
                  : "可直接手填；留空沿用消息的原始 routing key"
              }
            >
              <ComboInput
                value={routingKey}
                choices={routingKeys ?? []}
                strict={strictKey}
                allowEmpty
                onValueChange={setRoutingKey}
                placeholder="例如 order.created"
              />
            </Field>
          </div>
        ) : null}
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
