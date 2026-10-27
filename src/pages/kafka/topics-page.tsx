import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useListFilter } from "@/hooks/use-list-filter";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Empty,
  ErrorState,
  Field,
  Input,
  Modal,
  RefreshButton,
  SearchInput,
  StaleNotice,
  TableActions,
  TableCell,
  TableRow,
} from "@/components/ui";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useTopics } from "@/hooks/use-broker-data";
import { useAnalyzeHotspots, useCreateTopic } from "@/hooks/use-topics";
import { errorMessage } from "@/lib/errors";
import { failureText, shouldReplaceWithError } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import { connectionPath } from "@/lib/nav";
import { TopicRetentionBatchModal } from "@/components/broker/topic-retention-batch";
import { TOPIC_COLUMNS } from "@/types/topic";
import type { HotspotReport } from "@/types";

/**
 * Kafka 主题列表。
 *
 * 过滤在前端做：主题名是元数据里已有的东西，为一次筛选再发一轮请求不划算。
 * 名称列链到主题详情，那里才有分区布局与副本同步情况。
 *
 * 「分区热点」是另一件事：列表上「12 个分区」这个数字看不出 11 个分区是空的、
 * 1 个分区扛了全部流量。分析要逐分区问水位，代价高，所以由用户勾选主题后触发。
 */
export function TopicsPage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useTopics(connectionId, true);
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [report, setReport] = useState<HotspotReport | null>(null);
  const [retention, setRetention] = useState(false);
  const analyze = useAnalyzeHotspots(connectionId);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    if (!needle) return data;
    return data.filter((topic) => topic.name.toLowerCase().includes(needle));
  }, [data, keyword]);

  // 首屏画表头 + 骨架行，而不是一整块灰条：数据到位时列宽不跳。
  const skeleton = isLoading && !data;

  // 刷新失败时留着旧的主题表：一次网络抖动不该把已经在看的列表清空。
  if (shouldReplaceWithError({ hasData: Boolean(data), isFetching: isLoading })) {
    return (
      <ErrorState
        message={failureText("读取主题列表", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="主题"
        description="分区布局、副本同步与容量分布，点开单个主题查看详情"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新主题列表", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      <PageToolbar
        hint={
          data?.length ? (
            <>
              共 {formatNumber(data.length)} 个主题
              {keyword.trim() ? ` · 命中 ${formatNumber(filtered.length)} 个` : ""}
            </>
          ) : undefined
        }
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={analyze.isPending}
              disabled={!selected.length || skeleton}
              onClick={() => {
                // 换了一批主题，旧结果就不该留在屏幕上 —— 它对应的是上一次的勾选。
                setReport(null);
                analyze.mutate(selected, { onSuccess: setReport });
              }}
              title="逐分区查询水位，代价随「主题数 × 分区数」增长，因此需要先选主题"
            >
              分析分区热点（{selected.length}）
            </Button>
            {selected.length ? (
              <>
                {/* 勾选的价值就在这三个按钮上：勾完只能「分析热点」的话，
                    想读消息或改保留还得一个个点进去。 */}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    navigate(`${connectionPath(connectionId as string, "messages")}?target=${encodeURIComponent(selected[0])}`)
                  }
                  disabled={selected.length > 1}
                  title={
                    selected.length > 1
                      ? "消息页一次只读一个主题，请只勾一个"
                      : "读这个主题里的消息"
                  }
                >
                  看消息
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRetention(true)}
                  title="批量把保留时长设成同一个值，先逐个核对再提交"
                >
                  设保留（{selected.length}）
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  清空选择
                </Button>
              </>
            ) : null}
            <Button size="sm" disabled={skeleton} onClick={() => setCreating(true)}>
              新建主题
            </Button>
          </>
        }
      >
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按主题名过滤"
          aria-label="过滤主题"
          icon
          box="page"
          className="w-64"
        />
      </PageToolbar>

      {report ? <HotspotPanel report={report} onClear={() => setReport(null)} /> : null}

      {!skeleton && !data?.length ? (
        <Empty
          title="没有主题"
          description="该集群尚未创建任何 topic"
          action={
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              新建第一个主题
            </Button>
          }
        />
      ) : (
        <Card>
          <CardHeader
            title={skeleton ? "主题" : `主题（${formatNumber(filtered.length)}）`}
            extra={
              /* 表头勾选框放在右上角这一栏、只覆盖当前过滤后看得到的主题：
                 标题是 `<h2>`，往里塞 input 会把标题的截断规则搞乱；而全选到一批
                 自己没看见的主题上，是这张表最容易出事的地方。 */
              <div className="flex items-center gap-3">
                {!skeleton && filtered.length ? (
                  <label className="flex cursor-pointer items-center gap-1.5 text-(length:--text-app-meta) text-slate-500">
                    <input
                      type="checkbox"
                      aria-label="全选当前列表里的主题"
                      checked={filtered.every((topic) => selected.includes(topic.name))}
                      ref={(node) => {
                        if (!node) return;
                        const picked = filtered.filter((topic) => selected.includes(topic.name)).length;
                        node.indeterminate = picked > 0 && picked < filtered.length;
                      }}
                      onChange={(event) =>
                        setSelected(
                          event.currentTarget.checked ? filtered.map((topic) => topic.name) : [],
                        )
                      }
                    />
                    全选
                  </label>
                ) : null}
                {selected.length ? (
                  <span className="text-(length:--text-app-meta) text-slate-500">已选 {selected.length} 个</span>
                ) : null}
              </div>
            }
          />
          <CardBody className="p-0">
            <DataTable
              columns={TOPIC_COLUMNS}
              loadingRows={skeleton ? 10 : undefined}
              refreshing={isLoading && !skeleton}
            >
              {filtered.map((topic) => {
                const detailPath = `${connectionPath(connectionId as string, "topics")}/${encodeURIComponent(topic.name)}`;
                return (
                  <TableRow
                    key={topic.name}
                    clickable
                    // 整行可点：列表页的主动作就是「看这个主题」，再去找右侧按钮是多余一步。
                    onClick={() => navigate(detailPath)}
                  >
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${topic.name}`}
                        checked={selected.includes(topic.name)}
                        onChange={() =>
                          setSelected((prev) =>
                            prev.includes(topic.name)
                              ? prev.filter((item) => item !== topic.name)
                              : [...prev, topic.name],
                          )
                        }
                      />
                    </TableCell>
                    <TableCell mono>
                      <Link
                        to={detailPath}
                        className="text-info hover:underline"
                      >
                        {topic.name}
                      </Link>
                      {topic.internal ? (
                        <span className="ml-2 text-(length:--text-app-meta) text-slate-500">
                          内部主题
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell muted numeric>
                      {formatNumber(topic.partitions)}
                    </TableCell>
                    <TableCell muted numeric>
                      {formatNumber(topic.replicationFactor)}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <TableActions>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            navigate(
                              `${connectionPath(connectionId as string, "messages")}?target=${encodeURIComponent(topic.name)}`,
                            )
                          }
                        >
                          查看消息
                        </Button>
                      </TableActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </DataTable>
            {!skeleton && !filtered.length ? (
              <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
                <p className="text-(length:--text-app-body) text-slate-500">没有名称匹配的主题</p>
                <Button size="xs" variant="ghost" onClick={() => setKeyword("")}>
                  清除过滤
                </Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}

      <CreateTopicModal open={creating} onClose={() => setCreating(false)} />

      {retention ? (
        <TopicRetentionBatchModal
          connectionId={connectionId}
          topics={selected}
          internal={(data ?? []).filter((topic) => topic.internal && selected.includes(topic.name)).map((topic) => topic.name)}
          onClose={() => setRetention(false)}
        />
      ) : null}
    </PageBody>
  );
}

/** 新建主题。只暴露排查时真正会改的三项：名字、分区数、副本因子。 */
function CreateTopicModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connectionId } = useParams();
  const create = useCreateTopic(connectionId);
  const [name, setName] = useState("");
  const [partitions, setPartitions] = useState("3");
  const [replication, setReplication] = useState("1");

  const parsedPartitions = Number.parseInt(partitions, 10);
  const parsedReplication = Number.parseInt(replication, 10);
  const nameInvalid = !name.trim();
  const partitionsInvalid = Number.isNaN(parsedPartitions) || parsedPartitions < 1;
  const replicationInvalid = Number.isNaN(parsedReplication) || parsedReplication < 0;
  const invalid = nameInvalid || partitionsInvalid || replicationInvalid;

  return (
    <Modal
      open={open}
      title="新建主题"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" loading={create.isPending} disabled={invalid} onClick={() => {
            if (invalid) return;
            create.mutate(
              {
                name: name.trim(),
                partitions: parsedPartitions,
                replicationFactor: parsedReplication,
              },
              { onSuccess: () => onClose() },
            );
          }}>
            {create.isPending ? "创建中…" : "创建"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="主题名称"
          hint="只允许字母、数字、`.`、`_`、`-`；Kafka 不支持分区数减少"
        >
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="orders.created"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="分区数" hint="决定并行度，也决定消费组的上限">
            <Input
              type="number"
              min={1}
              value={partitions}
              onChange={(event) => setPartitions(event.currentTarget.value)}
            />
          </Field>
          <Field label="副本因子" hint="填 0 表示使用服务端默认值">
            <Input
              type="number"
              min={0}
              value={replication}
              onChange={(event) => setReplication(event.currentTarget.value)}
            />
          </Field>
        </div>
        {partitionsInvalid ? (
          <p className="text-(length:--text-app-body) text-rose-700">分区数至少为 1</p>
        ) : null}
      </div>
    </Modal>
  );
}

/** 分区热点结果面板：先给结论，再给明细。 */
function HotspotPanel({ report, onClear }: { report: HotspotReport; onClear: () => void }) {
  return (
    <Card>
      <CardHeader
        title={
          <div className="flex items-center gap-2">
            <span>分区热点</span>
            <span className="text-(length:--text-app-meta) font-normal text-slate-500">
              已分析 {formatNumber(report.topics.length)} 个主题 · 热点{" "}
              {formatNumber(report.hotspots.length)} 个
            </span>
            <Button size="sm" variant="ghost" onClick={onClear}>
              收起
            </Button>
          </div>
        }
      />
      <CardBody className="p-0">
        {report.missing.length ? (
          <p className="px-4 py-2 text-(length:--text-app-meta) text-amber-700">
            {formatNumber(report.missing.length)} 个主题已不存在：
            {report.missing.join("、")}
          </p>
        ) : null}
        {report.topics.length === 0 ? (
          <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">选中的主题都不存在了。</p>
        ) : report.hotspots.length === 0 ? (
          <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">
            没有发现分区倾斜：消息在各分区上分布均匀，或者总量太小还看不出趋势。
          </p>
        ) : (
          <table className="w-full text-left text-(length:--text-app-body)">
            <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">
              <tr className="border-b border-slate-200">
                <th className="px-4 py-2 font-normal">主题</th>
                <th className="px-4 py-2 font-normal">最热分区</th>
                <th className="px-4 py-2 font-normal">总消息</th>
                <th className="px-4 py-2 font-normal">空分区</th>
                <th className="px-4 py-2 font-normal">说明</th>
              </tr>
            </thead>
            <tbody>
              {report.hotspots.map((item) => (
                <tr key={item.topic} className="border-b border-slate-200 last:border-0">
                  <td className="px-4 py-2 font-mono text-slate-800">{item.topic}</td>
                  <td className="px-4 py-2 text-rose-700">
                    P{item.hottest ?? "-"} · {formatNumber(item.maxMessages)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{formatNumber(item.messages)}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {formatNumber(item.empty)} / {formatNumber(item.partitions)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{item.note ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}
