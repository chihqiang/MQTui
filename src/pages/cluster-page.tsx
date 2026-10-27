import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { Badge, Button, Callout, ErrorState, RefreshButton, StaleNotice } from "@/components/ui";
import { MonitorCard, FactLine, MonitorGrid, RatioBar } from "@/components/layout/monitor-grid";
import { PageFrame, PageHeader } from "@/components/layout/page-header";
import { useCluster, useNodeStats } from "@/hooks/use-cluster";
import { useConnections } from "@/hooks/use-connections";
import {
  describeCluster,
  fdRatioText,
  memRatioText,
  nodeTone,
  roleTone,
  SEVERITY_TONE,
  statTone,
  verdictTone,
} from "@/lib/cluster";
import { errorMessage } from "@/lib/errors";
import { failureText, shouldReplaceWithError } from "@/lib/failure";
import { formatBytes, formatNumber } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  brokerBadgeLabel,
  brokerBadgeTone,
  describeScope,
  ratio,
  type BrokerBadgeTone,
} from "@/lib/monitor-layout";
import type { ClusterAlert, ClusterNode, NodeStat, NodeVerdict } from "@/types";

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
            <p className="text-xs text-slate-500">
              没有需要处理的节点（共 {data.nodes.length} 个，都正常）。
              <Button variant="ghost" size="sm" onClick={() => setOnlyAttention(false)}>
                显示全部
              </Button>
            </p>
          ) : (
            <p className="max-w-md text-center text-xs text-slate-500">
              读不到节点列表。RabbitMQ 的节点信息依赖管理插件（管理 API 地址）；Kafka 需要
              bootstrap 可达。
            </p>
          )}
        </div>
      ) : (
        <MonitorGrid minCardWidth={330}>
          {nodes.map((node) => (
            <NodeCard
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

/** 这个节点该不该在「只看需处理」里留下：不运行、有告警、或后端标了 attention。 */
function needsAttention(node: ClusterNode, verdict: NodeVerdict | undefined): boolean {
  return !node.running || Boolean(verdict?.attention);
}

function AlertLine({ alert }: { alert: ClusterAlert }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
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

/**
 * 一张节点卡。
 *
 * 「承载」这一列在两个中间件下含义不同：RabbitMQ 是队列数，Kafka 是 leader 分区数。
 * 共用同一个位置是为了让两张表长得一样，文案上必须说清是哪一种，不能只留一个数字。
 */
function NodeCard({
  node,
  stat,
  verdict,
  broker,
}: {
  node: ClusterNode;
  stat: NodeStat | undefined;
  verdict: NodeVerdict | undefined;
  /** 中间件身份：一张卡自己说不清「我是 Kafka 还是 RabbitMQ」。 */
  broker: { label: string; tone: BrokerBadgeTone } | null;
}) {
  return (
    <MonitorCard
      title={
        <span className="flex items-center gap-2">
          {broker ? (
            // 只在卡片左侧描一道身份色的边，不额外塞一个标签 ——
            // 每张卡都带一个「Kafka」徽标，一屏 8 张卡就是 8 份噪音。
            <span
              aria-label={broker.label}
              className={cn(
                "h-3.5 w-0.5 shrink-0 rounded-full",
                broker.tone === "broker-kafka" ? "bg-broker-kafka" : "bg-broker-rabbitmq",
              )}
            />
          ) : null}
          <span className="font-mono text-xs text-slate-800">{node.name}</span>
          <Badge tone={roleTone(node.role)}>{node.roleLabel}</Badge>
          <Badge tone={nodeTone(node)}>{node.running ? "运行中" : "未运行"}</Badge>
        </span>
      }
      extra={
        verdict ? (
          <Badge tone={verdictTone(verdict)}>{verdict.attention ? "需处理" : "正常"}</Badge>
        ) : null
      }
      footer={verdict?.attention ? verdict.headline : undefined}
    >
      <div className="px-3 py-1.5">
        <FactLine label="地址">{node.endpoint ?? "—"}</FactLine>
        <FactLine label={node.queues !== undefined ? "队列" : "leader 分区"}>
          {loadText(node)}
        </FactLine>
        {stat ? (
          <>
            <ResourceLine
              label="内存"
              used={stat.memUsed}
              total={stat.memLimit}
              text={memRatioText(stat)}
              tone={barTone(stat)}
            />
            <ResourceLine
              label="fd"
              used={stat.fdUsed}
              total={stat.fdTotal}
              text={fdRatioText(stat)}
              tone={barTone(stat)}
            />
            <FactLine label="磁盘余量" tone={stat.diskLimit > 0 && stat.diskFree < stat.diskLimit ? "danger" : "normal"}>
              {/* `diskFree` 是字节数：直接打出来是 `107374182400`，读不出是多是少。
                  下限一起附上，才算把「够不够」说完。 */}
              {formatBytes(stat.diskFree)}
              {stat.diskLimit > 0 ? (
                <span className="text-slate-500"> / 下限 {formatBytes(stat.diskLimit)}</span>
              ) : null}
            </FactLine>
            <FactLine label="水位告警" tone={stat.alarm ? "danger" : "muted"}>
              {stat.alarm ? "已触发（发布方被阻塞）" : "无"}
            </FactLine>
          </>
        ) : null}
        {verdict && verdict.attention ? (
          <p className="mt-1 text-(length:--text-app-meta) text-slate-500">{verdict.detail}</p>
        ) : null}
      </div>
    </MonitorCard>
  );
}

function ResourceLine({
  label,
  used,
  total,
  text,
  tone,
}: {
  label: string;
  used: number;
  total: number;
  text: string | null;
  tone: "success" | "warning" | "danger";
}) {
  // 上限没上报时 `text` 为 null：这时不画条子，只写「未知」——
  // 一根空条子会被读成「用了 0%」，那是这类面板最典型的骗人方式。
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-(length:--text-app-meta)">
      <span className="shrink-0 text-slate-500">{label}</span>
      <RatioBar value={ratio(used, total)} text={text ?? "未知"} tone={tone} />
    </div>
  );
}

/**
 * 占比条的色调：`statTone` 在正常时返回 neutral，而条子只有成功/警告/危险三档。
 * 正常态按绿色处理，别在卡片里出现一根没有颜色的条。
 */
function barTone(stat: NodeStat): "success" | "warning" | "danger" {
  const tone = statTone(stat);
  return tone === "danger" || tone === "warning" ? tone : "success";
}

function loadText(node: ClusterNode): string {
  if (node.queues !== undefined) return `${formatNumber(node.queues)} 个队列`;
  if (node.leaders !== undefined) return `${formatNumber(node.leaders)} 个`;
  return "—";
}
