import { useMemo, useState } from "react";
import { useParams } from "react-router";

import {
  Badge,
  Button,
  DataTable,
  Empty,
  ErrorState,
  RefreshButton,
  SearchInput,
  SkeletonRows,
  StaleNotice,
  TableActions,
  TableCell,
  TableRow,
  type DataTableColumn,
} from "@/components/ui";
import { MonitorCard, MonitorGrid } from "@/components/layout/monitor-grid";
import { PageFrame, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useListFilter } from "@/hooks/use-list-filter";
import { useQueueConsumers } from "@/hooks/use-queue-consumers";
import {
  CONSUMER_HEALTH_LABEL,
  CONSUMER_HEALTH_TONE,
  QUEUE_VERDICT_LABEL,
  QUEUE_VERDICT_TONE,
  describeOverview,
  judgeConsumer,
  matchQueue,
  queueVerdict,
} from "@/lib/consumer-link";
import { DISCONNECT_VERDICT_NOTE, evaluateDisconnect } from "@/lib/consumer-disconnect";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import { describeScope } from "@/lib/monitor-layout";
import type { ConsumerLinks, QueueConsumption, QueueConsumer } from "@/types";

import { ConsumerDisconnectModal } from "@/pages/rabbitmq/consumer-disconnect";

const CONSUMER_COLUMNS: DataTableColumn[] = [
  { key: "connection", label: "连接" },
  { key: "user", label: "账号", width: "w-24" },
  { key: "ack", label: "ack", width: "w-16" },
  { key: "prefetch", label: "预取", width: "w-20", align: "right" },
  { key: "unacked", label: "未确认", width: "w-20", align: "right" },
  { key: "state", label: "状态", width: "w-24" },
  { key: "actions", label: <span className="sr-only">操作</span>, width: "w-16", align: "right" },
];

/**
 * 消费者页：从队列视角看「谁在消费、预取多少、是不是卡住了」。
 *
 * 队列列表只给消费者个数，那是个会骗人的数字 —— 预取塞满的消费者照样挂在上面。
 * 这一页把每个消费者的预取上限和未确认数摆出来，卡死的那一行无处可藏。
 *
 * 布局按仪表盘来：一个队列一张卡，卡片分栏。这里刻意不把「无消费者的队列」
 * 单独折叠成一行 —— 「队列堆着消息却没人消费」正是这页最想让人看见的结论，
 * 藏起来等于把页面存在的意义藏起来。
 */
export function ConsumersPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useQueueConsumers(connectionId);
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  const [onlyBroken, setOnlyBroken] = useState(false);
  // 待断开的消费者：连同它所属队列一起记，确认框需要队列名做二次校验。
  const [target, setTarget] = useState<{ queue: QueueConsumption; consumer: QueueConsumer } | null>(
    null,
  );

  const queues = useMemo(() => {
    if (!data) return [];
    return data.queues.filter((item) => {
      if (onlyBroken && queueVerdict(item) === "healthy") return false;
      return matchQueue(item, keyword);
    });
  }, [data, keyword, onlyBroken]);

  if (error && !data) {
    return (
      <PageFrame>
        <PageHeader title="消费者" />
        <ErrorState
          message={failureText("读取消费者", errorMessage(error))}
          onRetry={() => void refetch()}
        />
      </PageFrame>
    );
  }

  const total = data?.queues.length ?? 0;

  return (
    <PageFrame>
      <PageHeader
        title="消费者"
        description={data ? describeOverview(data) : "正在读取消费者…"}
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新消费者", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      <PageToolbar
        hint={
          data
            ? `${describeScope(queues.length, total, "个队列")} · 未确认合计 ${formatNumber(
                data.unacknowledgedTotal,
              )}`
            : undefined
        }
      >
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="队列 / 连接名 / consumer tag / 账号"
          aria-label="过滤消费者"
          className="h-8 w-64 text-(length:--text-app-body)"
        />
        <label className="flex items-center gap-1.5 text-(length:--text-app-meta) text-slate-500">
          <input
            type="checkbox"
            checked={onlyBroken}
            onChange={(event) => setOnlyBroken(event.currentTarget.checked)}
          />
          只看有问题的队列
        </label>
      </PageToolbar>

      {isLoading && !data ? <SkeletonRows rows={8} label="读取消费者…" /> : null}

      {data && total === 0 ? (
        <Empty
          title="读不到任何队列"
          description="消费者连线依赖 RabbitMQ 管理插件（管理 API 地址），请检查连接配置"
        />
      ) : null}

      {queues.length > 0 ? (
        <MonitorGrid minCardWidth={380} maxColumns={2}>
          {queues.map((item) => (
            <QueueCard
              key={item.queue}
              item={item}
              onDisconnect={(consumer) => setTarget({ queue: item, consumer })}
            />
          ))}
        </MonitorGrid>
      ) : null}

      {total > 0 && queues.length === 0 ? (
        <p className="text-(length:--text-app-body) text-slate-500">
          {onlyBroken
            ? `共 ${total} 个队列，没有一个是卡住或无人消费的。`
            : "没有符合条件的队列。"}
        </p>
      ) : null}

      <ConsumerDisconnectModal
        connectionId={connectionId}
        target={target}
        onClose={() => setTarget(null)}
      />
    </PageFrame>
  );
}

function QueueCard({
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
function DisconnectButton({
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
