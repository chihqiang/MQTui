import { useParams } from "react-router";

import { Card, CardBody, CardHeader, ErrorState, Loading } from "@/components/ui";
import { useOverview } from "@/hooks/use-broker-data";
import { errorMessage } from "@/lib/errors";

/** 概览：展示后端返回的键值信息，不为每种中间件写一套组件。 */
export function OverviewPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useOverview(connectionId);

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;

  return (
    <div className="h-full overflow-auto p-6">
      <Card>
        <CardHeader title={data?.title ?? "概览"} />
        <CardBody>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data?.items.map((item) => (
              <div key={item.key} className="flex flex-col rounded border border-slate-800 p-2.5">
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">{item.key}</dt>
                <dd className="truncate text-sm text-slate-200">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
