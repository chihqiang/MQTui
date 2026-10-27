import { useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Button, Card, CardBody, CardHeader, Empty, ErrorState, Loading } from "@/components/ui";
import { useHealth } from "@/hooks/use-health";
import { useQueues } from "@/hooks/use-broker-data";
import { useDeleteQueue, usePurgeQueue } from "@/hooks/use-queue-actions";
import { errorMessage } from "@/lib/errors";
import { formatNumber } from "@/lib/format";

import { QueueDetailModal } from "./queue-detail";

/**
 * RabbitMQ 队列列表。数据来自管理插件 HTTP API，未配置时为空。
 *
 * 写操作（清空 / 删除）需要管理 API 的 configure 权限，健康检查里已经探过一次，
 * 没权限时按钮直接置灰 —— 让用户点一下再看到「权限不足」是种浪费。
 */
export function QueuesPage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQueues(connectionId, true);
  const { canWrite } = useHealth(connectionId);
  const purge = usePurgeQueue(connectionId);
  const remove = useDeleteQueue(connectionId);
  const [detail, setDetail] = useState<string | null>(null);

  const busy = purge.isPending || remove.isPending;

  // 删除成功后关掉详情弹窗：留着会立刻报「队列不存在」。
  const handleDelete = (queue: string) => {
    if (!window.confirm(`删除队列 ${queue}？队列非空时会被服务端拒绝。`)) return;
    remove.mutate(queue, { onSuccess: () => setDetail(null) });
  };

  const handlePurge = (queue: string) => {
    if (!window.confirm(`清空队列 ${queue} 中的全部消息？此操作不可撤销。`)) return;
    purge.mutate(queue);
  };

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  if (!data?.length) {
    return (
      <Empty
        title="暂未发现队列"
        description="队列列表依赖 RabbitMQ 管理插件（15672 端口），请检查连接配置中的管理 API 地址"
      />
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <Card>
        <CardHeader title={`队列（${data.length}）`} />
        <CardBody className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2 font-normal">名称</th>
                <th className="px-4 py-2 font-normal">vhost</th>
                <th className="px-4 py-2 font-normal">消息数</th>
                <th className="px-4 py-2 font-normal">消费者</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.map((queue) => (
                <tr key={`${queue.vhost}/${queue.name}`} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-2 font-mono text-xs text-slate-200">{queue.name}</td>
                  <td className="px-4 py-2 text-slate-400">{queue.vhost}</td>
                  <td className="px-4 py-2 text-slate-400">{formatNumber(queue.messages)}</td>
                  <td className="px-4 py-2 text-slate-400">{formatNumber(queue.consumers)}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(queue.name)}>
                        详情
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          navigate(
                            `/connections/${connectionId}/messages?target=${encodeURIComponent(queue.name)}`,
                          )
                        }
                      >
                        查看消息
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <QueueDetailModal
        connectionId={connectionId}
        queue={detail}
        canWrite={canWrite}
        busy={busy}
        onClose={() => setDetail(null)}
        onPurge={handlePurge}
        onDelete={handleDelete}
      />
    </div>
  );
}
