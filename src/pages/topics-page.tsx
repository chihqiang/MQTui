import { useNavigate, useParams } from "react-router";

import { Button, Card, CardBody, CardHeader, Empty, ErrorState, Loading } from "@/components/ui";
import { useTopics } from "@/hooks/use-broker-data";
import { errorMessage } from "@/lib/errors";
import { formatNumber } from "@/lib/format";

/** Kafka 主题列表。 */
export function TopicsPage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useTopics(connectionId, true);

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  if (!data?.length) return <Empty title="没有主题" description="该集群尚未创建任何 topic" />;

  return (
    <div className="h-full overflow-auto p-6">
      <Card>
        <CardHeader title={`主题（${data.length}）`} />
        <CardBody className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2 font-normal">名称</th>
                <th className="px-4 py-2 font-normal">分区</th>
                <th className="px-4 py-2 font-normal">副本</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.map((topic) => (
                <tr key={topic.name} className="border-b border-slate-800/60 last:border-0">
                  <td className="px-4 py-2 font-mono text-xs text-slate-200">{topic.name}</td>
                  <td className="px-4 py-2 text-slate-400">{formatNumber(topic.partitions)}</td>
                  <td className="px-4 py-2 text-slate-400">
                    {formatNumber(topic.replicationFactor)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        navigate(
                          `/connections/${connectionId}/messages?target=${encodeURIComponent(topic.name)}`,
                        )
                      }
                    >
                      查看消息
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}
