import { useParams } from "react-router";

import { QuotaTable, ScramTable } from "@/components/broker";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorState,
  RefreshButton,
} from "@/components/ui";
import { useQuotas, useScramCredentials } from "@/hooks/use-quota";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import {
  groupQuotas,
  partialUsers,
  quotaEmptyTitle,
  quotaVerdict,
  scramReadable,
  scramVerdictOf,
} from "@/lib/quota";

/**
 * Kafka 准入页：客户端配额 + SASL/SCRAM 凭据。
 *
 * 这一屏回答两个运维最常被问、面板之前答不出的问题：**谁被限速了**、
 * **谁能连上**。它们同属准入面，所以放在一页；但分成两块、两个查询，
 * 因为失败面完全不同 —— 配额读不到是常态（librdkafka 未导出
 * `DescribeClientQuotas`），SCRAM 读不到要么是权限、要么是 broker 版本。
 * 合成一个查询，一个失败会把另一栏也拖成错误态。
 *
 * 两栏都只读。`AlterUserScramCredentials` 同样没有导出，
 * 硬凑出来的写按钮只会给人一种「已经改好了」的错觉。
 */
export function AccessPage() {
  const { connectionId } = useParams();
  const quotas = useQuotas(connectionId);
  const scram = useScramCredentials(connectionId);

  return (
    <PageBody>
      <PageHeader
        title="准入"
        description="谁被限速、谁能连上；两栏都只读，改动请用 kafka-configs.sh"
        actions={
          <RefreshButton
            state={{
              firstLoad: !quotas.data && !scram.data,
              refreshing: quotas.isFetching || scram.isFetching,
              hasData: Boolean(quotas.data) || Boolean(scram.data),
            }}
            onRefresh={() => {
              void quotas.refetch();
              void scram.refetch();
            }}
          />
        }
      />

      <Card>
        <CardHeader
          title="客户端配额"
          extra={
            quotas.data ? (
              <span className="text-meta">{quotaVerdict(quotas.data)}</span>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {quotas.error && !quotas.data ? (
            // 配额读不到不挂整页错误：这一栏照常说明情况，另一栏还能用。
            <div className="flex flex-col gap-2 px-4 py-3">
              <p className="text-(length:--text-app-body) text-slate-700">
                {failureText("读取配额", errorMessage(quotas.error))}
              </p>
              <p className="text-meta">
                配额并没有失效，只是这里问不到。查改用 kafka-configs.sh --describe
                --entity-type users
              </p>
            </div>
          ) : quotas.data && groupQuotas(quotas.data.entries).length ? (
            <QuotaTable groups={groupQuotas(quotas.data.entries)} />
          ) : quotas.isLoading ? (
            <QuotaTable groups={[]} loading />
          ) : (
            <Empty
              title={quotas.data ? quotaEmptyTitle(quotas.data) : "还没有配额"}
              description={
                quotas.data?.error ??
                "没配配额时 Kafka 用 broker 的默认值，通常等于不限速"
              }
            />
          )}
        </CardBody>
        {quotas.data?.notes.length ? (
          <CardBody className="flex flex-col gap-1 border-t border-slate-200">
            {quotas.data.notes.map((note) => (
              <p key={note} className="text-meta">
                {note}
              </p>
            ))}
          </CardBody>
        ) : null}
      </Card>

      {scram.error && !scram.data ? (
        <ErrorState
          message={failureText("读取 SCRAM 凭据", errorMessage(scram.error))}
          onRetry={() => void scram.refetch()}
        />
      ) : (
        <Card>
          <CardHeader
            title="SASL/SCRAM 凭据"
            extra={
              scram.data ? (
                <span className="text-meta">{scramVerdictOf(scram.data)}</span>
              ) : undefined
            }
          />
          <CardBody className="flex flex-col gap-2">
            {scram.data && partialUsers(scram.data).length > 0 ? (
              <Callout tone="warning">
                有 {partialUsers(scram.data).length} 个用户只配了一种机制：用另一种机制
                连接的客户端会直接认证失败，而错误信息通常只说「认证失败」，不说是机制不对。
              </Callout>
            ) : null}

            {scram.data?.unsupported ? (
              // 老 broker 返回空表时最容易被读成「一个 SCRAM 用户都没有」，
              // 排查方向会整个跑偏，所以这句必须比表格更显眼。
              <Callout tone="info">{scram.data.unsupported}</Callout>
            ) : null}

            {scram.isLoading ? (
              <ScramTable users={[]} loading />
            ) : scram.data && !scramReadable(scram.data) ? null : scram.data?.users
                .length ? (
              <ScramTable users={scram.data.users} />
            ) : (
              <Empty
                title="没有 SCRAM 用户"
                description="SASL/SCRAM 是 Kafka 自己的账号体系；用 PLAIN 或 mTLS 认证的集群不上这里"
              />
            )}

            {scram.data?.notes.length ? (
              <div className="flex flex-col gap-1">
                {scram.data.notes.map((note) => (
                  <p key={note} className="text-meta">
                    {note}
                  </p>
                ))}
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="为什么这里没有「新建 / 修改」" />
        <CardBody className="flex flex-col gap-2">
          <p className="text-(length:--text-app-body) text-slate-700">
            librdkafka 2.12 只导出了「查」，没有导出改：配额要
            <span className="mx-1 font-mono">AlterClientQuotas</span>
            ，凭据要
            <span className="mx-1 font-mono">AlterUserScramCredentials</span>
            。面板能看清现状，改的路留给命令行。
          </p>
          <p className="text-meta">
            半吊子的写入按钮比没有更糟：它会让人以为改成功了，直到下一次认证失败。
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">只读</Badge>
            <Badge tone="neutral">kafka-configs.sh --alter</Badge>
          </div>
        </CardBody>
      </Card>
    </PageBody>
  );
}
