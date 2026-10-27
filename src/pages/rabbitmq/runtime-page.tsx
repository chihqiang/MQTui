import { useMemo, useState } from "react";
import { useParams } from "react-router";

import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Input,
  RefreshButton,
  SkeletonRows,
  StaleNotice,
  DataTable,
  TableActions,
  TableCell,
  TableRow,
  type DataTableColumn,
} from "@/components/ui";
import { MonitorCard, MonitorGrid } from "@/components/layout/monitor-grid";
import { PageFrame, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useRuntime, useRuntimeActions } from "@/hooks/use-cluster";
import { useListFilter } from "@/hooks/use-list-filter";
import { errorMessage } from "@/lib/errors";
import { failureText, shouldReplaceWithError } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import { describeScope } from "@/lib/monitor-layout";
import {
  channelIdle,
  channelSaturated,
  channelTone,
  describeRuntime,
  connectionHasProblem,
  connectionTone,
  matchConnection,
} from "@/lib/runtime";
import { useSessionStore } from "@/stores";
import type { ChannelRow, ConnectionDetail } from "@/types";

const CHANNEL_COLUMNS: DataTableColumn[] = [
  { key: "channel", label: "通道" },
  { key: "user", label: "账号", width: "w-24" },
  { key: "consumers", label: "消费者", width: "w-20", align: "right" },
  { key: "prefetch", label: "预取", width: "w-20", align: "right" },
  { key: "unacked", label: "未确认", width: "w-24", align: "right" },
  { key: "acks", label: "已确认", width: "w-24", align: "right" },
  { key: "state", label: "状态", width: "w-24" },
  { key: "actions", label: <span className="sr-only">操作</span>, width: "w-20", align: "right" },
];

type Target = { kind: "connection" | "channel"; detail: ConnectionDetail; name: string };

/**
 * RabbitMQ 运行时页：谁连着我、每条连接上开着哪些通道、队列落在哪个节点。
 *
 * 与「消费者」页的分工：那页从队列出发看「谁在消费」，这页从连接出发看
 * 「账号开了多少东西」。排查「连接泄漏」「某个服务把所有预取吃满」时，
 * 队列视角看不到，因为问题出在连接和通道这一层。
 *
 * 布局按仪表盘来：一条连接一张卡、卡片分栏。这里刻意不做「连接 → 通道」
 * 的树形展开 —— 展开是点一下的事，而先看见「哪几条连接有问题」是这页的全部价值。
 */
export function RuntimePage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useRuntime(connectionId);
  // 过滤词存 URL：从这条连接点去看队列、再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  const [onlyProblem, setOnlyProblem] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);

  const connections = useMemo(() => {
    if (!data) return [];
    return data.connections.filter((detail) => {
      if (onlyProblem && !connectionHasProblem(detail)) return false;
      return matchConnection(detail, keyword);
    });
  }, [data, keyword, onlyProblem]);

  if (shouldReplaceWithError({ hasData: Boolean(data), isFetching: isLoading })) {
    return (
      <ModalFreeError
        message={failureText("读取运行时视图", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageFrame>
      <PageHeader
        title="连接与通道"
        description={data ? describeRuntime(data) : "读取运行时视图…"}
        actions={
          <RefreshButton
            size="sm"
            state={{ firstLoad: false, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新运行时视图", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      {/* 「没有节点的队列」排在最上面：这是这一页唯一会当场丢消息的状态。 */}
      {data && data.unassigned.length > 0 ? (
        <Callout tone="danger">
          {data.unassigned.length} 个队列没有可用节点：
          <span className="ml-1 font-mono">{data.unassigned.join("、")}</span>
        </Callout>
      ) : null}

      <PageToolbar
        hint={
          data
            ? describeScope(connections.length, data.connections.length, "个连接")
            : undefined
        }
      >
        <Input
          className="h-8 w-64 text-(length:--text-app-body)"
          value={keyword}
          placeholder="连接名 / 客户端名 / 账号 / 对端地址"
          aria-label="过滤连接"
          onChange={(event) => setKeyword(event.currentTarget.value)}
        />
        <label className="flex items-center gap-1.5 text-(length:--text-app-meta) text-slate-500">
          <input
            type="checkbox"
            checked={onlyProblem}
            onChange={(event) => setOnlyProblem(event.currentTarget.checked)}
          />
          只看有问题的连接
        </label>
      </PageToolbar>

      {isLoading && !data ? <SkeletonRows rows={6} label="读取运行时…" /> : null}

      {data && data.connections.length === 0 ? (
        <p className="max-w-md text-(length:--text-app-body) text-slate-500">
          读不到连接列表。运行时视图依赖 RabbitMQ 管理插件，请检查连接配置里的管理 API 地址。
        </p>
      ) : null}

      {connections.length > 0 ? (
        <MonitorGrid minCardWidth={380} maxColumns={2}>
          {connections.map((detail) => (
            <ConnectionCard
              key={detail.connection.name}
              detail={detail}
              onClose={(kind, name) => setTarget({ kind, detail, name })}
            />
          ))}
        </MonitorGrid>
      ) : null}

      {data && data.connections.length > 0 && connections.length === 0 ? (
        <p className="text-(length:--text-app-body) text-slate-500">
          {onlyProblem
            ? `共 ${data.connections.length} 条连接，没有一条有问题。`
            : "没有符合条件的连接。"}
        </p>
      ) : null}

      <CloseConfirmModal connectionId={connectionId} target={target} onClose={() => setTarget(null)} />
    </PageFrame>
  );
}

/** 首屏失败时也用页面外壳，避免错误页单独占满一屏、页头消失。 */
function ModalFreeError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <PageFrame>
      <PageHeader title="连接与通道" />
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-center" role="alert">
          <p className="selectable max-w-xl text-(length:--text-app-title) text-rose-700">{message}</p>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            重试
          </Button>
        </div>
      </div>
    </PageFrame>
  );
}

/**
 * 一条连接一张卡。
 *
 * 通道表在卡片内部滚动、表头吸顶：一条连接挂几十个通道很常见，
 * 让整张卡把一屏吃光，其它连接就永远看不见了。
 */
function ConnectionCard({
  detail,
  onClose,
}: {
  detail: ConnectionDetail;
  onClose: (kind: "connection" | "channel", name: string) => void;
}) {
  const { connection, channels } = detail;

  return (
    <MonitorCard
      scroll={channels.length > 8}
      title={
        <span className="flex items-center gap-2">
          <Badge tone={connectionTone(connection)}>{connection.state}</Badge>
          <span className="truncate font-mono text-(length:--text-app-body) text-slate-800">
            {connection.clientName || connection.name}
          </span>
        </span>
      }
      extra={
        <>
          {detail.saturated > 0 ? (
            <Badge tone="danger">{detail.saturated} 个通道预取已满</Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onClose("connection", connection.name)}>
            关闭连接
          </Button>
        </>
      }
      footer={
        <div className="flex flex-wrap items-center gap-x-3">
          <span>{connection.user || "—"}</span>
          <span className="font-mono">
            {connection.peerHost}:{connection.peerPort}
          </span>
          <span>{connection.channels} 个通道</span>
          <span>未确认 {formatNumber(detail.unackedTotal)}</span>
        </div>
      }
    >
      {channels.length === 0 ? (
        <p className="px-3 py-2 text-(length:--text-app-meta) text-slate-500">这条连接上没有打开的通道。</p>
      ) : (
        <DataTable columns={CHANNEL_COLUMNS} stickyHeader className="text-(length:--text-app-body)">
          {channels.map((channel) => (
            <ChannelTableRow
              key={channel.name}
              channel={channel}
              onClose={() => onClose("channel", channel.name)}
            />
          ))}
        </DataTable>
      )}
    </MonitorCard>
  );
}

function ChannelTableRow({ channel, onClose }: { channel: ChannelRow; onClose: () => void }) {
  const state = channelSaturated(channel) ? "预取已满" : channelIdle(channel) ? "空转" : "正常";

  return (
    <TableRow>
      <TableCell mono className="text-slate-600">
        {channel.name}
      </TableCell>
      <TableCell muted>{channel.user || "—"}</TableCell>
      <TableCell muted numeric>
        {channel.consumers}
      </TableCell>
      <TableCell muted numeric>
        {channel.prefetch === 0 ? "不限" : formatNumber(channel.prefetch)}
      </TableCell>
      <TableCell muted numeric>
        {formatNumber(channel.unacked)}
      </TableCell>
      <TableCell muted numeric>
        {formatNumber(channel.acks)}
      </TableCell>
      <TableCell>
        <Badge tone={channelTone(channel)}>{state}</Badge>
      </TableCell>
      <TableCell align="right">
        <TableActions>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </TableActions>
      </TableCell>
    </TableRow>
  );
}

/**
 * 关闭连接 / 通道的确认框。
 *
 * 这两件事都是「替别人动手」：对端会直接收到连接关闭，在途消息重新入队。
 * 所以确认框里要写清受影响的范围（多少个通道、多少未确认消息），
 * 而不是只问一句「确定吗」。
 */
function CloseConfirmModal({
  connectionId,
  target,
  onClose,
}: {
  connectionId: string | undefined;
  target: Target | null;
  onClose: () => void;
}) {
  const { closeConnection, closeChannel } = useRuntimeActions(connectionId);
  const pushToast = useSessionStore((state) => state.pushToast);

  if (!target) return null;

  const isConnection = target.kind === "connection";
  const pending = isConnection ? closeConnection : closeChannel;
  const consumers =
    target.detail.channels.find((item) => item.name === target.name)?.consumers ?? 0;

  return (
    <ConfirmDialog
      open
      title={isConnection ? "关闭连接" : "关闭通道"}
      confirmLabel="确认关闭"
      loading={pending.isPending}
      danger
      onClose={onClose}
      onConfirm={() => {
        pending.mutate(target.name, {
          onSuccess: () => {
            pushToast("success", `已关闭${isConnection ? "连接" : "通道"}`);
            onClose();
          },
          onError: (error) => pushToast("error", errorMessage(error)),
        });
      }}
    >
      <div className="flex flex-col gap-2 text-(length:--text-app-body) text-slate-600">
        <p className="font-mono break-all text-slate-800">{target.name}</p>
        {isConnection ? (
          <p>
            这条连接上开着 {target.detail.channels.length} 个通道，未确认消息{" "}
            {formatNumber(target.detail.unackedTotal)} 条。关闭后对端会立即断开，未确认的消息由服务端重新入队。
          </p>
        ) : (
          <p>关闭该通道会让它上面的 {consumers} 个消费者一起消失。</p>
        )}
        <p className="text-slate-500">
          对端通常会自动重连 —— 这个动作适合用来踢掉一个卡死的客户端，不适合用来「限制对方」。
        </p>
      </div>
    </ConfirmDialog>
  );
}

