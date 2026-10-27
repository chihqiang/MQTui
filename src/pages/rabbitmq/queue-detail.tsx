import { useState } from "react";

import {
  Badge,
  Button,
  DescriptionGrid,
  ErrorState,
  Loading,
  Modal,
  SectionTitle,
  StaleNotice,
  type DescriptionItem,
} from "@/components/ui";
import { useQueueDetail } from "@/hooks/use-queue-actions";
import { useQueueConsumers } from "@/hooks/use-queue-consumers";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import type { ConsumerLinks, QueueConsumer, QueueDetail } from "@/types";

import { ConsumerDisconnectModal } from "@/pages/rabbitmq/consumer-disconnect";
import { ConsumerBlock } from "@/pages/rabbitmq/consumers-page";

/** 队列详情弹窗。`queue` 为 null 时关闭。 */
export function QueueDetailModal({
  connectionId,
  queue,
  onClose,
  onPurge,
  onDelete,
  canWrite,
  busy,
}: {
  connectionId: string | undefined;
  queue: string | null;
  onClose: () => void;
  onPurge: (queue: string) => void;
  onDelete: (queue: string) => void;
  /** 写权限未通过时，删除按钮置灰并给出原因。 */
  canWrite: boolean;
  busy: boolean;
}) {
  const { data, isLoading, error, refetch } = useQueueDetail(connectionId, queue ?? undefined);
  // 消费者列表是整连接一次拉全的，详情里直接复用，不再单独请求一个队列。
  const consumers = useQueueConsumers(connectionId);
  const [target, setTarget] = useState<{ queue: string; consumer: QueueConsumer } | null>(null);

  return (
    <Modal
      open={Boolean(queue)}
      title={queue ?? ""}
      onClose={onClose}
      footer={
        queue ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onPurge(queue)}
            >
              清空消息
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy || !canWrite}
              title={canWrite ? undefined : "当前账号没有管理 API 写权限"}
              onClick={() => onDelete(queue)}
            >
              删除队列
            </Button>
          </>
        ) : null
      }
    >
      {/* 详情已经读到过就继续显示：刷新失败时把弹窗换成错误页，
          等于「点一下刷新，刚看到的消息三态全没了」。 */}
      {error && data ? (
        <StaleNotice
          message={failureText("刷新队列", errorMessage(error), data.name)}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}
      {isLoading && !data ? <Loading label="读取队列详情…" /> : null}
      {error && !data ? (
        <ErrorState
          message={failureText("读取队列", errorMessage(error), queue ?? undefined)}
          onRetry={() => void refetch()}
        />
      ) : null}
      {data ? (
        <DetailBody
          detail={data}
          consumers={consumers.data}
          onDisconnect={(consumer) => setTarget({ queue: data.name, consumer })}
        />
      ) : null}

      <ConsumerDisconnectModal
        connectionId={connectionId}
        target={
          target && consumers.data
            ? {
                queue: consumers.data.queues.find((item) => item.queue === target.queue) ?? {
                  queue: target.queue,
                  messagesReady: 0,
                  messagesUnacknowledged: 0,
                  consumers: [],
                  unhealthy: 0,
                },
                consumer: target.consumer,
              }
            : null
        }
        onClose={() => setTarget(null)}
      />
    </Modal>
  );
}

function DetailBody({
  detail,
  consumers,
  onDisconnect,
}: {
  detail: QueueDetail;
  consumers?: ConsumerLinks;
  onDisconnect?: (consumer: QueueConsumer) => void;
}) {
  return (
    <div className="flex flex-col gap-4 text-xs">
      {/* 三态必须拆开写：总数 / 待投递 / 未确认。一个「消息数」看不出是没人消费
          还是消费者卡在确认上，这两件事的处置完全相反。 */}
      <DescriptionGrid items={describeFacts(detail)} />

      {detail.arguments?.length ? (
        <section>
          <SectionTitle>参数</SectionTitle>
          <ul className="flex flex-wrap gap-1.5">
            {detail.arguments.map((argument) => (
              <li key={argument.key}>
                <Badge tone="info">
                  {argument.key} = {argument.value}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <SectionTitle>消费者</SectionTitle>
        {consumers ? (
          <ConsumerBlock links={consumers} queue={detail.name} onDisconnect={onDisconnect} />
        ) : (
          <p className="text-xs text-slate-500">消费者信息需要管理 API，暂不可用。</p>
        )}
      </section>

      <section>
        <SectionTitle>消息来源（绑定）</SectionTitle>
        {detail.bindings?.length ? (
          <ul className="flex flex-col gap-1">
            {detail.bindings.map((binding) => (
              <li key={`${binding.source}|${binding.routingKey}`} className="font-mono text-(length:--text-app-meta)">
                <span className="text-slate-300">{binding.source || "(默认交换机)"}</span>
                <span className="mx-1 text-slate-600">→</span>
                <span className="text-info">{binding.routingKey || "(空)"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-500">
            没有任何交换机绑定到该队列。若消息只靠默认交换机按队列名直投，这里是空的属于正常。
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * 队列详情的事实栏。
 *
 * 未确认数不为 0 时染黄：它多半意味着「消费者取走了但没确认」，
 * 是排查卡单的第一现场，不该和 0 长得一样。
 */
function describeFacts(detail: QueueDetail): DescriptionItem[] {
  return [
    { label: "状态", value: detail.state },
    { label: "消费者", value: formatNumber(detail.consumers) },
    { label: "消息总数", value: formatNumber(detail.messages) },
    { label: "待投递", value: formatNumber(detail.messagesReady) },
    {
      label: "未确认",
      value: formatNumber(detail.messagesUnacknowledged),
      tone: detail.messagesUnacknowledged > 0 ? "warning" : "normal",
    },
    { label: "入队速率", value: formatRate(detail.incomingRate) },
    { label: "投递速率", value: formatRate(detail.deliverRate) },
    { label: "vhost", value: detail.vhost },
    {
      label: "属性",
      value: [detail.durable ? "durable" : "非持久化", detail.autoDelete ? "auto-delete" : null]
        .filter(Boolean)
        .join(" / "),
    },
  ];
}

function formatRate(rate: number): string {
  // 0 不代表「没有速率」，只是这一瞬间没有增减；写 0/s 会被读成「停了」。
  return rate ? `${rate.toFixed(2)}/s` : "—";
}
