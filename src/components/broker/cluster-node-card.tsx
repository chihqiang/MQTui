import { Badge } from "@/components/ui";
import { FactLine, MonitorCard, RatioBar } from "@/components/layout/monitor-grid";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import {
  barTone,
  fdRatioText,
  loadText,
  memRatioText,
  nodeTone,
  roleTone,
  verdictTone,
} from "@/lib/cluster";
import { ratio } from "@/lib/monitor-layout";
import type { ClusterNode, NodeStat, NodeVerdict } from "@/types";
import type { BrokerTone } from "@/types/tone";

/**
 * 一张节点卡。
 *
 * 「承载」这一列在两个中间件下含义不同：RabbitMQ 是队列数，Kafka 是 leader 分区数。
 * 共用同一个位置是为了让两张表长得一样，文案上必须说清是哪一种 —— 见 `loadText`。
 *
 * 从集群页搬出来，是因为它是这一页唯一「认识节点」的块；页面自己只该负责
 * 取数与分栏。配色与文案都走 `lib/cluster.ts`，这里只排版。
 */
export function ClusterNodeCard({
  node,
  stat,
  verdict,
  broker,
}: {
  node: ClusterNode;
  stat: NodeStat | undefined;
  verdict: NodeVerdict | undefined;
  /** 中间件身份：一张卡自己说不清「我是 Kafka 还是 RabbitMQ」。 */
  broker: { label: string; tone: BrokerTone } | null;
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
          <span className="font-mono text-(length:--text-app-body) text-slate-800">{node.name}</span>
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
            <FactLine
              label="磁盘余量"
              tone={stat.diskLimit > 0 && stat.diskFree < stat.diskLimit ? "danger" : "normal"}
            >
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
