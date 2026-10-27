import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { Badge, Button, Callout, ErrorState, RefreshButton, StaleNotice } from "@/components/ui";
import { ClusterNodeCard } from "@/components/broker";
import { MonitorGrid } from "@/components/layout/monitor-grid";
import { PageFrame, PageHeader } from "@/components/layout/page-header";
import { useCluster, useNodeStats } from "@/hooks/use-cluster";
import { useConnections } from "@/hooks/use-connections";
import { describeCluster, needsAttention, SEVERITY_TONE } from "@/lib/cluster";
import { errorMessage } from "@/lib/errors";
import { failureText, shouldReplaceWithError } from "@/lib/failure";
import { brokerBadgeLabel, brokerBadgeTone, describeScope } from "@/lib/monitor-layout";
import type { ClusterAlert } from "@/types";

/**
 * 集群页：Kafka 与 RabbitMQ 共用。
 *
 * 两个中间件的节点结构被抹平成同一张「节点卡」（名字 / 角色 / 存活 / 承载），
 * 因为「集群少了谁」是同一个问题。差异全放进结论区：
 * Kafka 报「没有 controller」「副本掉队」，RabbitMQ 报「水位告警」「磁盘不够」。
 *
 * 这页是**仪表盘不是列表**：正常状态下信息量一屏装得下，所以页头固定、
 * 卡片分栏、整块内容区滚动，滚到哪儿都还看得见上面那行结论。
 */
export function ClusterPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useCluster(connectionId);
  // 页头要标出「现在看的是哪种中间件」：两种连接并排打开时，
  // 这页的内容长得很像，标题上那行小字是唯一线索。
  const { data: connections } = useConnections();
  const kind = connections?.find((item) => item.id === connectionId)?.kind;
  const brokerLabel = brokerBadgeLabel(kind);
  const brokerTone = brokerBadgeTone(kind);
  // 节点指标（内存 / 磁盘 / fd）单独一次请求：拿不到不影响「谁在运行」这个结论。
  const stats = useNodeStats(connectionId);
  const [onlyAttention, setOnlyAttention] = useState(false);

  const verdicts = useMemo(
    () => new Map((stats.data?.verdicts ?? []).map((item) => [item.name, item])),
    [stats.data],
  );
  const statMap = useMemo(
    () => new Map((stats.data?.stats ?? []).map((item) => [item.name, item])),
    [stats.data],
  );

  const nodes = useMemo(() => {
    const list = data?.nodes ?? [];
    if (!onlyAttention) return list;
    return list.filter((node) => needsAttention(node, verdicts.get(node.name)));
  }, [data, onlyAttention, verdicts]);

  if (shouldReplaceWithError({ hasData: Boolean(data), isFetching: isLoading })) {
    return (
      <ErrorState
        message={failureText("读取集群状态", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }

  const alerts = data?.alerts ?? [];

  return (
    <PageFrame>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span>集群</span>
            {brokerLabel && brokerTone ? <Badge tone={brokerTone}>{brokerLabel}</Badge> : null}
          </span>
        }
        description={data ? describeCluster(data.nodes, data.alerts.length) : "读取集群…"}
        actions={
          <>
            {/* 筛选在仪表盘上必须显式：条数从 N 变成 0 时，人会以为数据没了。 */}
            <label className="flex items-center gap-1.5 text-(length:--text-app-meta) text-slate-500">
              <input
                type="checkbox"
                checked={onlyAttention}
                onChange={(event) => setOnlyAttention(event.currentTarget.checked)}
              />
              只看需处理
            </label>
            <RefreshButton
              state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
              onRefresh={() => {
                void refetch();
                void stats.refetch();
              }}
            />
          </>
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新集群状态", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      {data && data.nodes.length > 0 ? (
        <p className="text-(length:--text-app-meta) text-slate-500">
          {describeScope(nodes.length, data.nodes.length, "个节点")}
          {stats.error ? " · 节点指标读取失败，仅显示存活与角色" : null}
        </p>
      ) : null}

      {/* 报警放在卡片上方：这页的第一句话应该是「有没有事」，不是「有几个节点」。 */}
      {alerts.length ? (
        <div className="flex flex-col gap-1.5">
          {alerts.map((alert) => (
            <AlertLine key={`${alert.severity}|${alert.title}`} alert={alert} />
          ))}
        </div>
      ) : data && data.nodes.length > 0 ? (
        <Callout tone="success">没有需要处理的结论：所有节点都在运行，也没有告警。</Callout>
      ) : null}

      {nodes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          {data && data.nodes.length > 0 ? (
            <p className="text-(length:--text-app-body) text-slate-500">
              没有需要处理的节点（共 {data.nodes.length} 个，都正常）。
              <Button variant="ghost" size="sm" onClick={() => setOnlyAttention(false)}>
                显示全部
              </Button>
            </p>
          ) : (
            <p className="max-w-md text-center text-(length:--text-app-body) text-slate-500">
              读不到节点列表。RabbitMQ 的节点信息依赖管理插件（管理 API 地址）；Kafka 需要
              bootstrap 可达。
            </p>
          )}
        </div>
      ) : (
        <MonitorGrid minCardWidth={330}>
          {nodes.map((node) => (
            <ClusterNodeCard
              key={node.name}
              node={node}
              stat={statMap.get(node.name)}
              verdict={verdicts.get(node.name)}
              // 身份色，不是告警色：amber / rose 留给 warn 与 danger。
              broker={brokerLabel && brokerTone ? { label: brokerLabel, tone: brokerTone } : null}
            />
          ))}
        </MonitorGrid>
      )}
    </PageFrame>
  );
}

function AlertLine({ alert }: { alert: ClusterAlert }) {
  return (
    <div className="flex items-baseline gap-2 text-(length:--text-app-body)">
      <Badge tone={SEVERITY_TONE[alert.severity]}>
        {alert.severity === "warn" ? "需要处理" : "提醒"}
      </Badge>
      <span className="shrink-0 text-slate-800">{alert.title}</span>
      <span className="min-w-0 truncate text-(length:--text-app-meta) text-slate-500" title={alert.detail}>
        {alert.detail}
      </span>
    </div>
  );
}
