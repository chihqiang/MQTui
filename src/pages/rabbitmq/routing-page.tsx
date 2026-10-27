import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { Badge, Card, CardBody, CardHeader, Empty, ErrorState, Loading } from "@/components/ui";
import { FilterBar, NavigateButton } from "@/components/broker";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useTopologyInsight } from "@/hooks/use-broker-data";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { messagesPath } from "@/lib/actions";
import { formatNumber } from "@/lib/format";
import { defaultExchangeLabel } from "@/lib/topology-graph";
import { ROUTE_CONFIDENCE_LABEL, ROUTE_CONFIDENCE_TONE } from "@/types/topology-insight";
import type { ExchangeRoute } from "@/types/topology-insight";

/**
 * 路由估算页：从交换机视角看「消息会落到哪些队列」。
 *
 * 与交换机页的分工：那边按绑定表逐条列事实，这边给结论——哪几个队列收得到、
 * 哪几个交换机是死路。排查「消息发给交换机后凭空消失」时直接看这一页。
 */
export function RoutingPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useTopologyInsight(connectionId, true);
  const [keyword, setKeyword] = useState("");
  const [onlyBroken, setOnlyBroken] = useState(false);

  const routes = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    return data.routes.filter((route) => {
      const broken = data.deadEnds.includes(route.exchange) || data.dangling.includes(route.exchange);
      if (onlyBroken && !broken) return false;
      if (!needle) return true;
      return (
        route.exchange.toLowerCase().includes(needle) ||
        route.queues.some((queue) => queue.toLowerCase().includes(needle))
      );
    });
  }, [data, keyword, onlyBroken]);

  if (isLoading) return <Loading />;
  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取路由估算", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return <Empty title="暂无路由数据" />;

  const brokenCount = data.deadEnds.filter(Boolean).length + data.dangling.length;

  return (
    <PageBody>
      <PageHeader
        title="路由估算"
        description="从交换机视角看「消息会落到哪些队列」，并标出死路与断链"
      />

      <PageToolbar hint={brokenCount ? `${brokenCount} 个交换机有问题` : undefined}>
        <FilterBar
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按交换机 / 队列名过滤"
          ariaLabel="过滤路由"
          onlyIssue={{
            checked: onlyBroken,
            onChange: setOnlyBroken,
            label: "只看有问题的交换机",
          }}
          summary={
            <>
              {formatNumber(data.routes.length)} 个交换机 · {formatNumber(brokenCount)} 个投放异常
            </>
          }
        />
      </PageToolbar>

      {brokenCount || data.stalled.length ? (
        <Card>
          <CardHeader title="需要关注" />
          <CardBody className="flex flex-col gap-2 text-(length:--text-app-body) text-slate-600">
            {data.deadEnds.length ? (
              <p>
                <span className="mr-2 text-rose-700">死路</span>
                没有任何出站绑定，消息进入即被丢弃：
                <span className="ml-1 font-mono text-slate-800">
                  {data.deadEnds.map(defaultExchangeLabel).join("、")}
                </span>
              </p>
            ) : null}
            {data.dangling.length ? (
              <p>
                <span className="mr-2 text-amber-700">断链</span>
                只转发给其它交换机，链路最终没落到队列：
                <span className="ml-1 font-mono text-slate-800">{data.dangling.join("、")}</span>
              </p>
            ) : null}
            {data.stalled.length ? (
              <p>
                <span className="mr-2 text-amber-700">堆积</span>
                队列有消息但没有消费者：
                <span className="ml-1 font-mono text-slate-800">{data.stalled.join("、")}</span>
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {routes.length ? (
        routes.map((route) => (
          <ExchangeRouteCard
            key={route.exchange}
            route={route}
            deadEnd={data.deadEnds.includes(route.exchange)}
            stalled={data.stalled}
            connectionId={connectionId}
          />
        ))
      ) : (
        <Empty
          title="没有匹配的交换机"
          description="路由估算依赖 RabbitMQ 管理插件（15672 端口），请检查连接配置中的管理 API 地址"
        />
      )}
    </PageBody>
  );
}

/** 单个交换机的路由卡片。 */
function ExchangeRouteCard({
  route,
  deadEnd,
  stalled,
  connectionId,
}: {
  route: ExchangeRoute;
  deadEnd: boolean;
  stalled: string[];
  connectionId: string | undefined;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono text-(length:--text-app-body) text-slate-800">{defaultExchangeLabel(route.exchange)}</span>
            <Badge tone={ROUTE_CONFIDENCE_TONE[route.confidence]}>
              {ROUTE_CONFIDENCE_LABEL[route.confidence]}
            </Badge>
            {deadEnd ? <Badge tone="danger">死路</Badge> : null}
          </span>
        }
        extra={
          <span className="text-(length:--text-app-meta) text-slate-500">
            出站绑定 {route.bindings} 条
            {route.exchangeHops ? ` · 其中 ${route.exchangeHops} 条指向交换机` : ""}
          </span>
        }
      />
      <CardBody className="p-0">
        {route.queues.length ? (
          <table className="w-full text-left text-(length:--text-app-title)">
            <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">
              <tr className="border-b border-slate-200">
                <th className="px-4 py-2 font-normal">队列</th>
                <th className="px-4 py-2 font-normal">routing key</th>
                <th className="px-4 py-2 font-normal">路径</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {route.hops.map((hop) => (
                <tr
                  key={`${hop.queue}|${hop.routingKey}|${hop.viaExchange}`}
                  className="border-b border-slate-200 last:border-0"
                >
                  <td className="px-4 py-2 font-mono text-(length:--text-app-body) text-slate-800">
                    {hop.queue}
                    {stalled.includes(hop.queue) ? (
                      <span className="ml-2 text-(length:--text-app-meta) text-amber-700">无消费者</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 font-mono text-(length:--text-app-body) text-slate-500">
                    {hop.routingKey || "-"}
                    {hop.share ? (
                      <span className="ml-2 text-(length:--text-app-meta) text-slate-500">
                        约 {Math.round(hop.share * 100)}%
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-(length:--text-app-meta) text-slate-500">
                    {hop.viaExchange ? "经交换机中转" : "直接绑定"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <NavigateButton size="xs" variant="ghost" to={messagesPath(connectionId, hop.queue)}>
                      查看消息
                    </NavigateButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">
            {deadEnd
              ? "这个交换机没有任何出站绑定，消息进入后会被静默丢弃。"
              : "出站绑定只指向交换机，链路最终没有落到队列。"}
          </p>
        )}
        {route.confidence === "partial" ? (
          <p className="border-t border-slate-200 px-4 py-2 text-(length:--text-app-meta) text-amber-700/80">
            topic 交换机的估算只看已存在的绑定：`*` 与 `#` 会匹配到尚未建绑定的队列名
          </p>
        ) : null}
        {route.confidence === "implicit" ? (
          <p className="border-t border-slate-200 px-4 py-2 text-(length:--text-app-meta) text-slate-500">
            默认交换机不走绑定表，按队列名精确投递
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

