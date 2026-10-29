import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { FilterBar } from "@/components/broker";
import { MonitorGrid, MonitorCard } from "@/components/layout/monitor-grid";
import { PageFrame, PageHeader, PageToolbar } from "@/components/layout/page-header";
import {
  Badge,
  Callout,
  DataTable,
  Empty,
  ErrorState,
  RefreshButton,
  SkeletonRows,
  StaleNotice,
  TableCell,
  TableRow,
} from "@/components/ui";
import { useConsumerOwnership } from "@/hooks/use-consumer-ownership";
import { useListFilter } from "@/hooks/use-list-filter";
import {
  connectionLabel,
  isUnconsumed,
  matchQueue,
  onlyTroubled,
  ownershipVerdict,
  queueVerdict,
} from "@/lib/consumer-ownership";
import { CONSUMER_HEALTH_LABEL, CONSUMER_HEALTH_TONE } from "@/lib/consumer-link";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import type { QueueOwnership } from "@/types";

/**
 * 消费归属页：把「谁在消费这个队列」从三张表拼回一句话。
 *
 * 消费者页回答的是「每个队列几个消费者、预取塞满没有」。这一页回答的是另一半：
 * **这条连接到底占了什么** —— 哪台机器（对端地址）、哪个账号、连接是否已经阻塞。
 *
 * 断开一个消费者的时候这件事立刻变得要命：你踢掉的可能是自己监控进程的最后一个
 * 消费者，也可能是业务服务 12 个 channel 里唯一在干活的那个。所以这一页刻意
 * 把「连接」而不是「消费者个数」摆在最显眼的位置。
 */
export function OwnershipPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useConsumerOwnership(connectionId);
  const [keyword, setKeyword] = useListFilter();
  const [brokenOnly, setBrokenOnly] = useState(false);

  const queues = useMemo(() => {
    if (!data) return [];
    const matched = data.queues.filter((item) => matchQueue(item, keyword));
    return brokenOnly ? onlyTroubled(matched) : matched;
  }, [data, keyword, brokenOnly]);

  if (error && !data) {
    return (
      <PageFrame>
        <PageHeader title="消费归属" />
        <ErrorState
          message={failureText("读取消费归属", errorMessage(error))}
          onRetry={() => void refetch()}
        />
      </PageFrame>
    );
  }

  const total = data?.queues.length ?? 0;

  return (
    <PageFrame>
      <PageHeader
        title="消费归属"
        description={data ? ownershipVerdict(data) : "正在读取消费归属…"}
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新消费归属", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      {data?.blockedConsumers ? (
        <Callout tone="danger">
          有 {data.blockedConsumers} 个消费者的连接已经不在运行（阻塞或正在关闭）。它们仍然挂在
          消费者列表上，消息却不会被投递 —— 这是「看起来有人在消费、队列却一直涨」最常见的原因。
        </Callout>
      ) : null}

      {data?.users.length ? (
        <MonitorGrid minCardWidth={320} maxColumns={3}>
          {data.users.map((user) => (
            <MonitorCard
              key={user.username}
              title={<span className="font-mono text-(length:--text-app-body) text-slate-800">{user.username}</span>}
              footer={
                <span className="flex flex-wrap gap-x-3">
                  <span>{user.consumers} 个消费者</span>
                  <span>{user.connections} 条连接</span>
                  <span>{user.queues.length} 个队列</span>
                </span>
              }
            >
              <div className="flex flex-col gap-1 px-3 py-2">
                <p className="text-meta">
                  这个账号消费的队列上还堆着 {formatNumber(user.messagesReady)} 条
                </p>
                <p className="truncate font-mono text-meta">{user.queues.join("、")}</p>
                {user.connections > 1 ? (
                  // 同一套凭证被几个服务共用：出事时无法从账号上判断是谁。
                  <p className="text-meta">这套凭证被 {user.connections} 条连接共用，出事时无法从账号判断是谁</p>
                ) : null}
              </div>
            </MonitorCard>
          ))}
        </MonitorGrid>
      ) : null}

      <PageToolbar
        hint={data ? `${queues.length} / ${total} 个队列` : undefined}
      >
        <FilterBar
          value={keyword}
          onValueChange={setKeyword}
          placeholder="队列 / 连接名 / 对端地址 / 账号"
          ariaLabel="过滤消费归属"
          onlyIssue={{
            checked: brokenOnly,
            onChange: setBrokenOnly,
            label: "只看有问题的队列",
          }}
        />
      </PageToolbar>

      {isLoading && !data ? <SkeletonRows rows={6} label="读取消费归属…" /> : null}

      {data && total === 0 ? (
        <Empty
          title="读不到任何队列"
          description="消费归属依赖 RabbitMQ 管理插件（管理 API 地址），请检查连接配置"
        />
      ) : null}

      {queues.length > 0 ? (
        <MonitorGrid minCardWidth={420} maxColumns={2}>
          {queues.map((queue) => (
            <OwnershipCard key={queue.queue} queue={queue} />
          ))}
        </MonitorGrid>
      ) : null}

      {total > 0 && queues.length === 0 ? (
        <p className="text-(length:--text-app-body) text-slate-500">
          {brokenOnly ? `共 ${total} 个队列，没有一个是卡住或无人消费的。` : "没有符合条件的队列。"}
        </p>
      ) : null}

      {data?.notes?.length ? (
        <div className="flex flex-col gap-1">
          {data.notes.map((note) => (
            <p key={note} className="text-meta">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </PageFrame>
  );
}

/** 一个队列一张卡：卡里是这条队列上每条连接的归属。 */
function OwnershipCard({ queue }: { queue: QueueOwnership }) {
  return (
    <MonitorCard
      scroll={queue.owners.length > 8}
      title={
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-(length:--text-app-body) text-slate-800">{queue.queue}</span>
          {isUnconsumed(queue) ? <Badge tone="danger">无人消费</Badge> : null}
        </span>
      }
      footer={
        <span className="flex flex-wrap gap-x-3">
          <span>待投递 {formatNumber(queue.messagesReady)}</span>
          <span>未确认 {formatNumber(queue.messagesUnacknowledged)}</span>
          <span>{queueVerdict(queue)}</span>
        </span>
      }
    >
      {queue.owners.length === 0 ? (
        <p className="px-3 py-2 text-(length:--text-app-meta) text-slate-500">
          {queue.messagesReady > 0
            ? "没有任何消费者连接该队列，消息只会越堆越多。"
            : "没有任何消费者，队列当前也没有堆积。"}
        </p>
      ) : (
        <DataTable
          columns={[
            { key: "connection", label: "连接 / 对端" },
            { key: "user", label: "账号", width: "w-28" },
            { key: "prefetch", label: "预取 / 未确认", width: "w-32" },
            { key: "health", label: "状态", width: "w-28" },
          ]}
          stickyHeader
          className="text-(length:--text-app-body)"
        >
          {queue.owners.map((owner) => (
            <TableRow key={`${owner.consumerTag}|${owner.channel ?? ""}`}>
              <TableCell>
                <span className="font-mono text-slate-800">{connectionLabel(owner)}</span>
                <span className="ml-1 text-(length:--text-app-meta) text-slate-500">
                  {owner.peer ?? "对端未知"}
                </span>
              </TableCell>
              <TableCell mono muted>
                {owner.username || "—"}
              </TableCell>
              <TableCell mono muted>
                {owner.ackRequired ? (owner.prefetchCount === 0 ? "不限" : owner.prefetchCount) : "自动 ack"}
                {" / "}
                {formatNumber(owner.messagesUnacknowledged)}
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  {owner.connectionBlocked ? <Badge tone="danger">连接已阻塞</Badge> : null}
                  {owner.health !== "healthy" ? (
                    <Badge tone={CONSUMER_HEALTH_TONE[owner.health]}>
                      {CONSUMER_HEALTH_LABEL[owner.health]}
                    </Badge>
                  ) : null}
                  {!owner.connectionBlocked && owner.health === "healthy" ? (
                    <Badge tone="neutral">正常</Badge>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </MonitorCard>
  );
}
