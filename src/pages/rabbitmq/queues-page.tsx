import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { useListFilter } from "@/hooks/use-list-filter";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Empty,
  ErrorState,
  RefreshButton,
  SearchInput,
  StaleNotice,
  TableActions,
  TableCell,
  TableRow,
} from "@/components/ui";
import { NavigateButton } from "@/components/broker";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useHealth } from "@/hooks/use-health";
import { useQueues } from "@/hooks/use-broker-data";
import { useDeleteQueue, usePurgeQueue } from "@/hooks/use-queue-actions";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { messagesPath } from "@/lib/actions";
import { formatNumber } from "@/lib/format";
import { QUEUE_COLUMNS } from "@/types/topology";

import { QueueDetailModal } from "@/components/broker/queue-detail-dialog";

/**
 * RabbitMQ 队列列表。数据来自管理插件 HTTP API，未配置时为空。
 *
 * 写操作（清空 / 删除）需要管理 API 的 configure 权限，健康检查里已经探过一次，
 * 没权限时按钮直接置灰 —— 让用户点一下再看到「权限不足」是种浪费。
 */
export function QueuesPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useQueues(connectionId, true);
  const { canWrite } = useHealth(connectionId);
  const purge = usePurgeQueue(connectionId);
  const remove = useDeleteQueue(connectionId);
  const [detail, setDetail] = useState<string | null>(null);
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  // 待确认的破坏性动作。集中在一处，队列详情弹窗和列表都能触发。
  const [pending, setPending] = useState<{ action: "purge" | "delete"; queue: string } | null>(
    null,
  );

  const busy = purge.isPending || remove.isPending;

  // 队列名过滤在前端做：管理 API 已经全量拉回来了，不值得再发一次请求。
  // 结果做 memo：这个数组直接喂给卡片列表，每次渲染重算一遍等于让整页
  // 的 props 全部换引用（几千个队列时这一步本身就要几十毫秒）。
  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return data ?? [];
    return (data ?? []).filter((queue) => queue.name.toLowerCase().includes(needle));
  }, [data, keyword]);

  // 读取失败但手里还有上一批队列时不清空：删除 / 清空的目标就在这张表里，
  // 把它换成错误页，用户连「刚才那条叫什么」都回不去看。
  if (error && !data?.length) {
    return (
      <ErrorState
        message={failureText("读取队列列表", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!isLoading && !data?.length) {
    return (
      <Empty
        title="暂未发现队列"
        description="队列列表依赖 RabbitMQ 管理插件（15672 端口），请检查连接配置中的管理 API 地址"
      />
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="队列"
        description="堆积累积量、消费者数与三态消息量，点开单行看参数与绑定来源"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data?.length ? (
        <StaleNotice
          message={failureText("刷新队列列表", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      <PageToolbar
        hint={
          data?.length ? (
            <>
              共 {formatNumber(data.length)} 个队列
              {keyword.trim() ? ` · 命中 ${formatNumber(filtered.length)} 个` : ""}
            </>
          ) : undefined
        }
      >
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按队列名过滤"
          aria-label="过滤队列"
          icon
          box="page"
          className="w-64"
        />
      </PageToolbar>

      <Card>
        <CardHeader title={`队列（${isLoading ? "…" : formatNumber(filtered.length)}）`} />
        <CardBody className="p-0">
          <DataTable
            columns={QUEUE_COLUMNS}
            // 首屏铺骨架；有数据时的刷新只亮那根细进度线，不把表换成灰条。
            loadingRows={isLoading ? 10 : undefined}
            refreshing={isLoading && filtered.length > 0}
          >
            {filtered.map((queue) => (
              <TableRow key={`${queue.vhost}/${queue.name}`}>
                <TableCell mono className="text-slate-800">
                  {queue.name}
                </TableCell>
                <TableCell muted>{queue.vhost}</TableCell>
                <TableCell muted numeric>
                  {formatNumber(queue.messages)}
                </TableCell>
                <TableCell muted numeric>
                  {formatNumber(queue.consumers)}
                </TableCell>
                <TableCell>
                  <TableActions>
                    <Button size="sm" variant="ghost" onClick={() => setDetail(queue.name)}>
                      详情
                    </Button>
                    <NavigateButton to={messagesPath(connectionId, queue.name)}>查看消息</NavigateButton>
                  </TableActions>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {!isLoading && !filtered.length ? (
            <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
              <p className="text-(length:--text-app-body) text-slate-500">没有名称匹配的队列</p>
              <Button size="xs" variant="ghost" onClick={() => setKeyword("")}>
                清除过滤
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.action === "delete" ? "删除队列" : "清空队列"}
        danger
        loading={busy}
        confirmLabel={pending?.action === "delete" ? "删除" : "清空"}
        description={
          pending?.action === "delete" ? (
            <>
              删除队列 <span className="font-mono text-slate-800">{pending.queue}</span>
              。队列非空时会被服务端拒绝 —— 需要先清空，或者让消费者取完。
            </>
          ) : pending ? (
            <>
              清空队列 <span className="font-mono text-slate-800">{pending.queue}</span>{" "}
              中的全部消息，此操作不可撤销。若是为了排查，先考虑只读地浏览消息。
            </>
          ) : null
        }
        onConfirm={() => {
          if (!pending) return;
          if (pending.action === "delete") {
            // 删除成功后关掉详情弹窗：留着会立刻报「队列不存在」。
            remove.mutate(pending.queue, { onSuccess: () => setDetail(null) });
          } else {
            purge.mutate(pending.queue);
          }
          setPending(null);
        }}
        onClose={() => setPending(null)}
      />

      <QueueDetailModal
        connectionId={connectionId}
        queue={detail}
        canWrite={canWrite}
        busy={busy}
        onClose={() => setDetail(null)}
        onPurge={(queue) => setPending({ action: "purge", queue })}
        onDelete={(queue) => setPending({ action: "delete", queue })}
      />
    </PageBody>
  );
}
