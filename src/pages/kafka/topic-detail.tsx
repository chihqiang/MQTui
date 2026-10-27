import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Empty,
  ErrorState,
  Field,
  Input,
  Modal,
  RefreshButton,
  SkeletonRows,
  StaleNotice,
  TableCell,
  TableRow,
  type DataTableColumn,
} from "@/components/ui";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { useDeleteTopic, useExpandTopic, useTopicCapabilities, useTopicDetail } from "@/hooks/use-topics";
import { errorMessage } from "@/lib/errors";
import { failureText, shouldReplaceWithError } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import { IconBack } from "@/lib/icons";
import { connectionPath } from "@/lib/nav";
import { MigrationPanel } from "@/pages/kafka/migration-panel";
import { TopicConfigEditor } from "@/pages/kafka/topic-config-editor";
import type { TopicDetail, TopicPartitionInfo } from "@/types";

/**
 * 分区表的列定义。
 *
 * 「副本」和「已同步副本」并排两列，是这一页的核心：排查「写不进去」时
 * 第一个要看的是有没有副本掉队，两串数字分开摆，肉眼比长度很容易漏，
 * 所以掉队的整行标红、顶部再给一条横幅。
 */
const PARTITION_COLUMNS: DataTableColumn[] = [
  { key: "partition", label: "分区", width: "w-16", align: "right" },
  { key: "leader", label: "Leader", width: "w-24", align: "right" },
  { key: "replicas", label: "副本" },
  { key: "isr", label: "已同步" },
  { key: "low", label: "起始位点", width: "w-28", align: "right" },
  { key: "high", label: "末尾位点", width: "w-28", align: "right" },
  { key: "messages", label: "消息数", width: "w-28", align: "right" },
];

/**
 * 主题详情：分区布局 + 副本同步 + 水位。
 *
 * 这一页要回答的是一类问题：「消息为什么写不进去」「某个分区是不是热点」。
 * 所以三列并排——副本数、已同步副本、消息数，一眼就能看出是副本掉队
 * 还是单分区堆积，不用在两页之间来回跳。
 */
export function TopicDetailPage() {
  const { connectionId, topicName } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useTopicDetail(connectionId, topicName);
  const [expanding, setExpanding] = useState(false);

  // 刷新失败但手里还有旧的分区表时，不清空内容 —— 一次网络抖动不该把
  // 已经在看的副本分布收走。只有确实什么都没有时才让错误页占位。
  if (shouldReplaceWithError({ hasData: Boolean(data), isFetching: isLoading })) {
    return (
      <ErrorState
        message={failureText("读取主题", errorMessage(error), topicName)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data && !isLoading) return <Empty title="主题不存在" description={topicName ?? ""} />;

  const outOfSync =
    data?.partitions.filter((item) => item.replicas.length !== item.inSyncReplicas.length) ?? [];
  const totalMessages =
    data?.partitions.reduce((sum, item) => sum + Math.max(item.high - item.low, 0), 0) ?? 0;

  return (
    <PageBody>
      <PageHeader
        title={
          <>
            <span className="font-mono">{topicName}</span>
            {data?.internal ? <Badge tone="warning">内部主题</Badge> : null}
            {data ? (
              <Badge tone={outOfSync.length ? "danger" : "success"}>
                {outOfSync.length ? `${outOfSync.length} 个分区副本未同步` : "全部副本已同步"}
              </Badge>
            ) : null}
          </>
        }
        description={
          data
            ? `${formatNumber(data.partitions.length)} 个分区 · ${formatNumber(totalMessages)} 条消息`
            : "读取主题详情…"
        }
        back={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconBack />}
            onClick={() => navigate(connectionPath(connectionId as string, "topics"))}
            aria-label="返回主题列表"
          />
        }
        actions={
          data ? (
            <>
              <RefreshButton
                state={{ firstLoad: false, refreshing: isLoading, hasData: Boolean(data) }}
                onRefresh={() => void refetch()}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  navigate(
                    `${connectionPath(connectionId as string, "messages")}?target=${encodeURIComponent(data.name)}`,
                  )
                }
              >
                查看消息
              </Button>
              <ExpandButton detail={data} onOpen={() => setExpanding(true)} />
              <DeleteTopicButton detail={data} />
            </>
          ) : null
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新主题", errorMessage(error), data.name)}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的分区分布
        </StaleNotice>
      ) : null}

      {outOfSync.length ? (
        <Callout tone="danger">
          分区 {outOfSync.map((item) => item.partition).join(", ")} 的副本未全部同步：
          leader 成了单点，写入可能受阻。先确认对应 broker 是否存活。
        </Callout>
      ) : null}

      <Card>
        <CardHeader
          title="分区"
          extra={
            data ? <span className="text-(length:--text-app-meta) text-slate-500">掉队的行标红</span> : null
          }
        />
        <CardBody className="p-0">
          <DataTable
            columns={PARTITION_COLUMNS}
            className="text-(length:--text-app-body)"
            loadingRows={isLoading && !data ? 6 : undefined}
          >
            {data?.partitions.map((partition) => (
              <PartitionRow key={partition.partition} partition={partition} />
            ))}
          </DataTable>
        </CardBody>
      </Card>

      {data ? (
        <MigrationPanel
          connectionId={connectionId}
          topic={data.name}
          disabled={data.internal}
          disabledReason="内部主题的分区布局由 Kafka 自行管理，不做重分配"
        />
      ) : null}

      <Card>
        <CardHeader
          title="配置项"
          extra={
            <span className="text-(length:--text-app-meta) text-slate-500">
              默认值不展示，Kafka 有上百个默认项
            </span>
          }
        />
        <CardBody className={data ? "p-0" : undefined}>
          {data ? (
            <TopicConfigEditor detail={data} connectionId={connectionId} />
          ) : (
            <SkeletonRows rows={4} className="p-0" />
          )}
        </CardBody>
      </Card>

      {data ? (
        <ExpandModal
          detail={data}
          open={expanding}
          onClose={() => setExpanding(false)}
          connectionId={connectionId}
        />
      ) : null}
    </PageBody>
  );
}

function PartitionRow({ partition }: { partition: TopicPartitionInfo }) {
  const inSync = partition.replicas.length === partition.inSyncReplicas.length;
  const messages = Math.max(partition.high - partition.low, 0);

  return (
    <TableRow className={inSync ? undefined : "bg-rose-50"}>
      <TableCell muted numeric>
        {partition.partition}
      </TableCell>
      <TableCell align="right">
        {partition.leader === undefined ? <Badge tone="danger">无 leader</Badge> : partition.leader}
      </TableCell>
      <TableCell mono muted>
        {partition.replicas.join(", ")}
      </TableCell>
      <TableCell mono className={inSync ? "text-slate-500" : "text-rose-700"}>
        {partition.inSyncReplicas.join(", ") || "无"}
      </TableCell>
      <TableCell muted numeric>
        {formatNumber(partition.low)}
      </TableCell>
      <TableCell muted numeric>
        {formatNumber(partition.high)}
      </TableCell>
      <TableCell numeric className="text-slate-600">
        {formatNumber(messages)}
      </TableCell>
    </TableRow>
  );
}

/** 扩容按钮：能不能点由后端能力决定，原因直接挂在 title 上。 */
function ExpandButton({ detail, onOpen }: { detail: TopicDetail; onOpen: () => void }) {
  const { connectionId } = useParams();
  const { data: caps } = useTopicCapabilities(connectionId, detail.name);

  if (caps && !caps.canExpand) {
    const reason = caps.reasons?.find((item) => item.key === "expand")?.value;
    return (
      <Button size="sm" variant="secondary" disabled title={reason}>
        扩容分区
      </Button>
    );
  }

  return (
    <Button size="sm" variant="secondary" onClick={onOpen}>
      扩容分区
    </Button>
  );
}

/** 删除主题：内部主题不给按钮，与后端 `TopicRemoval` 保持同一套规则。 */
function DeleteTopicButton({ detail }: { detail: TopicDetail }) {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { data: caps } = useTopicCapabilities(connectionId, detail.name);
  const remove = useDeleteTopic(connectionId);
  const [confirming, setConfirming] = useState(false);

  if (caps && !caps.canDelete) {
    const reason = caps.reasons?.find((item) => item.key === "delete")?.value;
    return (
      <Button size="sm" variant="ghost" disabled title={reason}>
        删除
      </Button>
    );
  }

  return (
    <>
      <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => setConfirming(true)}>
        删除
      </Button>
      <ConfirmDialog
        open={confirming}
        title="删除主题"
        danger
        loading={remove.isPending}
        confirmLabel="删除"
        requirePhrase={detail.name}
        description={
          <>
            不可撤销：主题上的所有消息会一并消失。分区上的消费者会当场失去分配。
          </>
        }
        onConfirm={() =>
          remove.mutate(
            { topic: detail.name, internal: detail.internal },
            { onSuccess: () => navigate(connectionPath(connectionId as string, "topics")) },
          )
        }
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** 扩容弹窗。目标分区数默认填「当前 + 1」，最少也得比当前多。 */
function ExpandModal({
  detail,
  open,
  onClose,
  connectionId,
}: {
  detail: TopicDetail;
  open: boolean;
  onClose: () => void;
  connectionId: string | undefined;
}) {
  const expand = useExpandTopic(connectionId);
  const current = detail.partitions.length;
  const [target, setTarget] = useState(String(current + 1));

  // 打开时对齐当前分区数，避免上次填的值残留成非法输入。
  useEffect(() => {
    if (open) setTarget(String(current + 1));
  }, [current, open]);

  const onChange = (value: string) => setTarget(value);
  const parsed = Number.parseInt(target, 10);
  const invalid = Number.isNaN(parsed) || parsed <= current;

  const submit = () => {
    if (invalid) return;
    expand.mutate(
      { topic: detail.name, partitions: parsed },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Modal
      open={open}
      title={`扩容分区 · ${detail.name}`}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            loading={expand.isPending}
            disabled={invalid}
            onClick={submit}
            title={invalid ? `目标分区数必须大于当前 ${current} 个` : undefined}
          >
            {expand.isPending ? "扩容中…" : "确认扩容"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-(length:--text-app-body) text-slate-500">
          当前 {current} 个分区。Kafka 只支持增加分区，减少分区不具备可行性，
          因此这里不给「缩容」的口子。
        </p>
        <Field
          label="目标分区数"
          hint="新增分区的消息只会按 key 哈希落到旧分区或新分区之一，历史消息不会重新分布"
        >
          <Input
            type="number"
            min={current + 1}
            value={target}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Field>
        {invalid ? (
          <p className="text-(length:--text-app-body) text-rose-700">目标分区数必须大于当前 {current} 个</p>
        ) : null}
      </div>
    </Modal>
  );
}
