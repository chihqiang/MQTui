import { useParams } from "react-router";

import {
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  RefreshButton,
  SkeletonRows,
} from "@/components/ui";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { useOverview } from "@/hooks/use-broker-data";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";

/** 概览：展示后端返回的键值信息，不为每种中间件写一套组件。 */
export function OverviewPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useOverview(connectionId);

  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取概览", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="概览"
        description="连接与集群的基础信息"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      <Card>
        <CardHeader title={data?.title ?? "概览"} />
        <CardBody>
          {isLoading ? (
            <SkeletonRows rows={6} className="p-0" label="读取概览…" />
          ) : (
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data?.items.map((item) => (
                <div
                  key={item.key}
                  className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-slate-50/60 p-2.5"
                >
                  <dt className="truncate text-(length:--text-app-meta) font-medium tracking-wide text-meta uppercase">
                    {item.key}
                  </dt>
                  <dd className="selectable truncate text-(length:--text-app-body) text-slate-800" title={item.value}>
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </CardBody>
      </Card>
    </PageBody>
  );
}
