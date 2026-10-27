import { Badge, Button, ErrorState, Loading, Modal } from "@/components/ui";
import { useQueueDetail } from "@/hooks/use-queue-actions";
import { errorMessage } from "@/lib/errors";
import { formatNumber } from "@/lib/format";
import type { QueueDetail } from "@/types";

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
      {isLoading ? <Loading label="读取队列详情…" /> : null}
      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : null}
      {data ? <DetailBody detail={data} /> : null}
    </Modal>
  );
}

function DetailBody({ detail }: { detail: QueueDetail }) {
  return (
    <div className="flex flex-col gap-4 text-xs">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <Item label="状态" value={detail.state} />
        <Item label="消费者" value={formatNumber(detail.consumers)} />
        <Item label="消息总数" value={formatNumber(detail.messages)} />
        <Item label="待投递" value={formatNumber(detail.messagesReady)} />
        <Item label="未确认" value={formatNumber(detail.messagesUnacknowledged)} />
        <Item label="入队速率" value={formatRate(detail.incomingRate)} />
        <Item label="投递速率" value={formatRate(detail.deliverRate)} />
        <Item label="vhost" value={detail.vhost} />
        <Item
          label="属性"
          value={[detail.durable ? "durable" : "非持久化", detail.autoDelete ? "auto-delete" : null]
            .filter(Boolean)
            .join(" / ")}
        />
      </dl>

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
        <SectionTitle>消息来源（绑定）</SectionTitle>
        {detail.bindings?.length ? (
          <ul className="flex flex-col gap-1">
            {detail.bindings.map((binding) => (
              <li key={`${binding.source}|${binding.routingKey}`} className="font-mono text-[11px]">
                <span className="text-slate-300">{binding.source || "(默认交换机)"}</span>
                <span className="mx-1 text-slate-600">→</span>
                <span className="text-sky-300">{binding.routingKey || "(空)"}</span>
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

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="font-mono text-slate-200">{value}</dd>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h4 className="mb-1.5 text-[11px] uppercase tracking-wide text-slate-500">{children}</h4>;
}

function formatRate(rate: number): string {
  return rate ? `${rate.toFixed(2)}/s` : "-";
}
