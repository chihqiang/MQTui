import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { Empty, ErrorState, RefreshButton, SkeletonRows, StaleNotice } from "@/components/ui";
import { ConsumerQueueCard, FilterBar } from "@/components/broker";
import { MonitorGrid } from "@/components/layout/monitor-grid";
import { PageFrame, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useListFilter } from "@/hooks/use-list-filter";
import { useQueueConsumers } from "@/hooks/use-queue-consumers";
import { describeOverview, matchQueue, queueVerdict } from "@/lib/consumer-link";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import { describeScope } from "@/lib/monitor-layout";
import type { QueueConsumption, QueueConsumer } from "@/types";

import { ConsumerDisconnectModal } from "@/components/broker/consumer-disconnect-dialog";

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
        <FilterBar
          value={keyword}
          onValueChange={setKeyword}
          placeholder="队列 / 连接名 / consumer tag / 账号"
          ariaLabel="过滤消费者"
          onlyIssue={{
            checked: onlyBroken,
            onChange: setOnlyBroken,
            label: "只看有问题的队列",
          }}
        />
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
            <ConsumerQueueCard
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
