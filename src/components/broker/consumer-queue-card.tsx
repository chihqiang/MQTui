import { Badge, Button, DataTable, TableActions, TableCell, TableRow } from "@/components/ui";
import { MonitorCard } from "@/components/layout/monitor-grid";
import {
  CONSUMER_HEALTH_LABEL,
  CONSUMER_HEALTH_TONE,
  QUEUE_VERDICT_LABEL,
  QUEUE_VERDICT_TONE,
  judgeConsumer,
  queueVerdict,
} from "@/lib/consumer-link";
import { DISCONNECT_VERDICT_NOTE, evaluateDisconnect } from "@/lib/consumer-disconnect";
import { formatNumber } from "@/lib/format";
import { CONSUMER_COLUMNS } from "@/types/consumer-link";
import type { ConsumerLinks, QueueConsumption, QueueConsumer } from "@/types";

export function ConsumerQueueCard({
  item,
  onDisconnect,
}: {
  item: QueueConsumption;
  onDisconnect: (consumer: QueueConsumer) => void;
}) {
  const verdict = queueVerdict(item);

  return (
    <MonitorCard
      scroll={item.consumers.length > 8}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-(length:--text-app-body) text-slate-800">{item.queue}</span>
          <Badge tone={QUEUE_VERDICT_TONE[verdict]}>{QUEUE_VERDICT_LABEL[verdict]}</Badge>
        </span>
      }
      footer={
        <span className="flex flex-wrap gap-x-3">
          <span>待投递 {formatNumber(item.messagesReady)}</span>
          <span>未确认 {formatNumber(item.messagesUnacknowledged)}</span>
          <span>消费者 {item.consumers.length}</span>
        </span>
      }
    >
      {item.consumers.length === 0 ? (
        <p className="px-3 py-2 text-(length:--text-app-meta) text-slate-500">
          {item.messagesReady > 0
            ? "没有任何消费者连接该队列，消息只会越堆越多。"
            : "没有任何消费者，队列当前也没有堆积。"}
        </p>
      ) : (
        <DataTable columns={CONSUMER_COLUMNS} stickyHeader className="text-(length:--text-app-body)">
          {item.consumers.map((consumer) => {
            const health = judgeConsumer(consumer);
            return (
              <TableRow key={`${consumer.consumerTag}|${consumer.channel ?? ""}`}>
                <TableCell mono className="text-slate-800">
                  {consumer.connectionName ?? consumer.consumerTag}
                  {consumer.channel ? (
                    <span className="ml-1 text-(length:--text-app-meta) text-slate-500">{consumer.channel}</span>
                  ) : null}
                </TableCell>
                <TableCell muted>{consumer.username || "—"}</TableCell>
                <TableCell muted>{consumer.ackRequired ? "手动" : "自动"}</TableCell>
                <TableCell muted numeric>
                  {consumer.prefetchCount === 0 ? "不限" : formatNumber(consumer.prefetchCount)}
                </TableCell>
                <TableCell muted numeric>
                  {formatNumber(consumer.messagesUnacknowledged)}
                </TableCell>
                <TableCell>
                  <Badge tone={CONSUMER_HEALTH_TONE[health]}>
                    {CONSUMER_HEALTH_LABEL[health]}
                  </Badge>
                </TableCell>
                <TableCell align="right">
                  <TableActions>
                    <DisconnectButton consumer={consumer} onDisconnect={onDisconnect} />
                  </TableActions>
                </TableCell>
              </TableRow>
            );
          })}
        </DataTable>
      )}
    </MonitorCard>
  );
}

/**
 * 断开按钮。不可断时不隐藏、只置灰并把原因挂在 title 上 ——
 * 直接消失会让人以为这个功能不存在。
 */
export function DisconnectButton({
  consumer,
  onDisconnect,
}: {
  consumer: QueueConsumer;
  onDisconnect: (consumer: QueueConsumer) => void;
}) {
  const verdict = evaluateDisconnect(consumer);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={verdict !== "allowed"}
      title={verdict === "allowed" ? "断开这个消费者" : DISCONNECT_VERDICT_NOTE[verdict]}
      onClick={() => onDisconnect(consumer)}
    >
      断开
    </Button>
  );
}

/**
 * 供队列详情弹窗复用的紧凑区块，避免详情里再放一整张卡。
 *
 * 断开按钮在这也放一份：排查时是从「这个队列没人干活」点进来看的，
 * 看完还要回消费者页再找一遍同一条，纯属折腾。
 */
export function ConsumerBlock({
  links,
  queue,
  onDisconnect,
}: {
  links: ConsumerLinks;
  queue: string;
  onDisconnect?: (consumer: QueueConsumer) => void;
}) {
  const item = links.queues.find((entry) => entry.queue === queue);
  if (!item || item.consumers.length === 0) {
    return <p className="text-(length:--text-app-body) text-slate-500">没有任何消费者连接该队列。</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-(length:--text-app-meta) font-mono">
      {item.consumers.map((consumer) => {
        const health = judgeConsumer(consumer);
        return (
          <li key={`${consumer.consumerTag}|${consumer.channel ?? ""}`} className="flex items-center gap-2">
            <span className="text-slate-600">{consumer.connectionName ?? consumer.consumerTag}</span>
            <span className="text-slate-500">{consumer.username || "—"}</span>
            <span className="text-slate-500">
              预取 {consumer.prefetchCount === 0 ? "不限" : consumer.prefetchCount}
            </span>
            <span className="text-slate-500">未确认 {formatNumber(consumer.messagesUnacknowledged)}</span>
            {health === "healthy" ? null : (
              <Badge tone={CONSUMER_HEALTH_TONE[health]}>{CONSUMER_HEALTH_LABEL[health]}</Badge>
            )}
            {onDisconnect ? (
              <DisconnectButton consumer={consumer} onDisconnect={onDisconnect} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
