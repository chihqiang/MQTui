import { useMemo, useState } from "react";
import { useParams } from "react-router";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorState,
  Input,
  Loading,
} from "@/components/ui";
import { NavigateButton } from "@/components/broker";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { useOrphanCandidates, useOrphanTopics } from "@/hooks/use-broker-data";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { messagesPath } from "@/lib/actions";
import { formatNumber } from "@/lib/format";
import { describeScope, orphanTone } from "@/lib/orphan-topics";
import type { OrphanScanScope, OrphanTopic } from "@/types/orphan";

/**
 * Kafka 无消费组主题。
 *
 * 判定口径：某个分区的末尾位点大于 0，且没有任何消费组提交过该分区的位点。
 * 这类分区意味着「有人在写、没人在读」——通常是消费服务挂了、消费组换名，
 * 或者 producer 打错了 topic。
 *
 * 扫描是全量瓶颈：范围没限定时要对「主题数 × 分区数」逐个问水位。
 * 所以这一页分两步——先拉候选主题（元数据请求，很快），用户挑好范围再开扫。
 */
export function OrphanTopicsPage() {
  const { connectionId } = useParams();
  const candidates = useOrphanCandidates(connectionId, true);
  const [selected, setSelected] = useState<string[]>([]);
  const [prefix, setPrefix] = useState("");
  const [keyword, setKeyword] = useState("");
  const [scanned, setScanned] = useState<OrphanScanScope | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const scope: OrphanScanScope = useMemo(
    () => ({ topics: selected, prefix }),
    [selected, prefix],
  );
  const targeted = selected.length > 0 || prefix.trim() !== "";

  const result = useOrphanTopics(connectionId, scanned ?? {}, scanned !== null);

  const visibleCandidates = useMemo(() => {
    const names = candidates.data ?? [];
    const needle = keyword.trim().toLowerCase();
    if (!needle) return names;
    return names.filter((name) => name.toLowerCase().includes(needle));
  }, [candidates.data, keyword]);

  if (candidates.isLoading) return <Loading label="读取主题列表…" />;
  if (candidates.error) {
    return (
      <ErrorState
        message={failureText("读取主题列表", errorMessage(candidates.error))}
        onRetry={() => void candidates.refetch()}
      />
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="无消费组主题"
        description="有堆积、却没有任何消费组提交过位点的分区：消费服务挂了、组改名，或者 producer 打错了 topic"
      />

      <Card>
        <CardHeader
          title="扫描范围"
          extra={<span className="text-(length:--text-app-body) text-slate-500">{describeScope(scope)}</span>}
        />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Input
                value={prefix}
                placeholder="主题前缀，例如 order."
                aria-label="主题前缀"
                onChange={(event) => setPrefix(event.currentTarget.value)}
              />
            </div>
            <div className="w-64">
              <Input
                value={keyword}
                placeholder="在候选里过滤"
                aria-label="过滤候选主题"
                onChange={(event) => setKeyword(event.currentTarget.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={result.isFetching}
              // 范围没变时也要重新扫：用户点「扫描」的意图通常就是「再算一次」。
              onClick={() => {
                setExpanded(null);
                setScanned({ ...scope });
                void result.refetch();
              }}
            >
              {targeted ? "扫描选中" : "全量扫描（慢）"}
            </Button>
            {selected.length || prefix ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelected([]);
                  setPrefix("");
                }}
              >
                清空选择
              </Button>
            ) : null}
          </div>

          <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto">
            {visibleCandidates.map((name) => {
              const active = selected.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() =>
                    setSelected(
                      active ? selected.filter((item) => item !== name) : [...selected, name],
                    )
                  }
                  className={
                    "rounded border px-2 py-1 font-mono text-(length:--text-app-meta) transition " +
                    (active
                      ? "border-accent bg-selection text-accent"
                      : "border-slate-200 text-slate-500 hover:border-slate-300")
                  }
                >
                  {name}
                </button>
              );
            })}
            {visibleCandidates.length ? null : (
              <p className="text-(length:--text-app-body) text-slate-500">没有匹配的主题</p>
            )}
          </div>

          <p className="text-(length:--text-app-meta) text-slate-500">
            不选范围时会扫描全部 {candidates.data?.length ?? 0} 个主题，逐个分区问水位，
            集群大的时候要等一会儿。
          </p>
        </CardBody>
      </Card>

      {scanned === null ? (
        <Empty
          title="尚未扫描"
          description="先选主题或填前缀，再点扫描；不选就是全量扫描"
        />
      ) : result.isLoading || result.isFetching ? (
        <Loading label="正在统计各分区堆积（分区越多越慢）…" />
      ) : result.error ? (
        <ErrorState
          message={failureText("扫描分区堆积", errorMessage(result.error))}
          onRetry={() => void result.refetch()}
        />
      ) : (
        <ScanResult
          data={result.data}
          connectionId={connectionId}
          expanded={expanded}
          onToggle={(topic) => setExpanded(expanded === topic ? null : topic)}
        />
      )}
    </PageBody>
  );
}

/** 扫描结果。`scanned` 与 `missing` 都要说清楚，否则「怎么少了几个主题」无从解释。 */
function ScanResult({
  data,
  connectionId,
  expanded,
  onToggle,
}: {
  data: ReturnType<typeof useOrphanTopics>["data"];
  connectionId: string | undefined;
  expanded: string | null;
  onToggle: (topic: string) => void;
}) {
  if (!data) return null;

  return (
    <>
      {data.missingTopics?.length ? (
        <p className="text-(length:--text-app-body) text-amber-400">
          以下主题在集群里不存在，已跳过：{data.missingTopics.join("、")}
        </p>
      ) : null}
      {data.items.length ? (
        <Card>
          <CardHeader
            title={`无消费组主题（${data.total}）`}
            extra={
              <span className="text-(length:--text-app-body) text-slate-500">
                扫描 {data.scannedTopics ?? 0} 个主题 · 按堆积量倒序
              </span>
            }
          />
          <CardBody className="p-0">
            <table className="w-full text-left text-(length:--text-app-title)">
              <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">
                <tr className="border-b border-slate-200">
                  <th className="px-4 py-2 font-normal">主题</th>
                  <th className="px-4 py-2 font-normal">堆积</th>
                  <th className="px-4 py-2 font-normal">未消费分区</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <OrphanRow
                    key={item.topic}
                    item={item}
                    connectionId={connectionId}
                    expanded={expanded === item.topic}
                    onToggle={() => onToggle(item.topic)}
                  />
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      ) : (
        <Empty
          title="没有堆积中的孤儿分区"
          description={
            data.scannedTopics
              ? `已扫描 ${data.scannedTopics} 个主题，其中所有有消息的分区都有消费组提交过位点`
              : "所选范围内没有可扫描的主题"
          }
        />
      )}
    </>
  );
}

/** 一行主题；展开后列出各分区的堆积量，排查时能直接看到是不是单分区热点。 */
function OrphanRow({
  item,
  connectionId,
  expanded,
  onToggle,
}: {
  item: OrphanTopic;
  connectionId: string | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-slate-200 last:border-0 hover:bg-slate-50"
        onClick={onToggle}
      >
        <td className="px-4 py-2 font-mono text-(length:--text-app-body) text-slate-800">{item.topic}</td>
        <td className="px-4 py-2">
          <Badge tone={orphanTone(item.messages)}>{formatNumber(item.messages)}</Badge>
        </td>
        <td className="px-4 py-2 text-slate-500">{formatNumber(item.partitions)}</td>
        <td className="px-4 py-2 text-right">
          <NavigateButton to={messagesPath(connectionId, item.topic)}>查看消息</NavigateButton>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-slate-200 bg-slate-100">
          <td colSpan={4} className="px-4 py-2">
            <div className="flex flex-wrap gap-2">
              {item.detail.map((partition) => (
                <span
                  key={partition.partition}
                  className="rounded border border-slate-200 px-2 py-1 font-mono text-(length:--text-app-meta) text-slate-500"
                >
                  p{partition.partition} · {formatNumber(partition.high)}
                </span>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

