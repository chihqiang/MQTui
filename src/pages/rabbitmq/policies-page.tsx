import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { useListFilter } from "@/hooks/use-list-filter";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Empty,
  ErrorState,
  RefreshButton,
  SearchInput,
  StaleNotice,
  TableActions,
  TableCell,
  TableRow,
  type DataTableColumn,
} from "@/components/ui";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useHealth } from "@/hooks/use-health";
import { useDeletePolicy, usePolicies } from "@/hooks/use-policies";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { APPLY_TO_OPTIONS, describeDefinition } from "@/lib/policy";
import type { OperatorPolicyInfo, PolicyApplyTo, PolicyInfo } from "@/types/policy";
import type { Tone } from "@/types/tone";

import { PolicyEditor } from "@/pages/rabbitmq/policy-editor";

/** 生效范围对应的色调：`all` 最容易误伤，用警示色而不是中性色。 */
const APPLY_TO_TONE: Record<PolicyApplyTo, Tone> = {
  queues: "info",
  exchanges: "info",
  all: "warning",
};

const APPLY_TO_LABEL: Record<PolicyApplyTo, string> = Object.fromEntries(
  APPLY_TO_OPTIONS.map((option) => [option.value, option.label]),
) as Record<PolicyApplyTo, string>;

const POLICY_COLUMNS: DataTableColumn[] = [
  { key: "name", label: "名称" },
  { key: "pattern", label: "匹配模式" },
  { key: "applyTo", label: "范围", width: "w-24" },
  { key: "priority", label: "优先级", width: "w-20", align: "right" },
  { key: "definition", label: "定义" },
  { key: "actions", label: <span className="sr-only">操作</span>, width: "w-32", align: "right" },
];

const OPERATOR_POLICY_COLUMNS: DataTableColumn[] = [
  { key: "name", label: "名称" },
  { key: "pattern", label: "匹配模式" },
  { key: "applyTo", label: "范围", width: "w-24" },
  { key: "priority", label: "优先级", width: "w-20", align: "right" },
  { key: "definition", label: "定义" },
];

/**
 * RabbitMQ 策略页。
 *
 * 策略是「声明式下发」：写在这里的规则不会立刻作用到已经存在的队列上，
 * 要等资源下次被声明才会套用。这个语义在页头写死，不藏在文档里 ——
 * 「我明明配了 TTL 却没生效」是这个页面最常见的困惑。
 *
 * 操作员策略单独一张表：用户改不了，混在普通策略里会让人误以为能随手改掉。
 */
export function PoliciesPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = usePolicies(connectionId);
  const { canWrite } = useHealth(connectionId);
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  const [editing, setEditing] = useState<PolicyInfo | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    if (!needle) return data.policies;
    return data.policies.filter((policy) =>
      [policy.name, policy.pattern, ...policy.definition.map((item) => item.key)]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [data, keyword]);

  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取策略", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  // 策略全部依赖管理 API。后端在未配置时直接报错而不是回空列表——
  // 「0 条策略」会被读成「这个 vhost 没有策略」，是错误结论。这里给出出路。
  if (!data && !isLoading) {
    return (
      <Empty
        title="策略需要 RabbitMQ 管理插件"
        description="请在连接配置里填写管理 API 地址（默认 15672 端口），否则无法读取或下发策略"
      />
    );
  }

  const writeHint = canWrite ? undefined : "当前账号没有管理 API 写权限";

  return (
    <PageBody>
      <PageHeader
        title="策略"
        description="TTL、死信、长度上限与镜像规则；写错不会报错，只会静默不生效"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新策略", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      <PageToolbar
        hint="策略只对「之后声明」的资源生效：已有的队列要重新声明或重启消费者才会套用"
        actions={
          <Button
            size="sm"
            disabled={!canWrite || isLoading}
            title={writeHint}
            onClick={() => setCreating(true)}
          >
            新建策略
          </Button>
        }
      >
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按名称 / 模式 / 键过滤"
          aria-label="过滤策略"
          icon
          box="page"
          className="w-64"
        />
      </PageToolbar>

      <Card>
        <CardHeader title={`策略（${isLoading ? "…" : filtered.length}）`} />
        <CardBody className="p-0">
          {isLoading || filtered.length ? (
            <DataTable columns={POLICY_COLUMNS} loadingRows={isLoading ? 5 : undefined}>
              {filtered.map((policy) => (
                <PolicyRow
                  key={policy.name}
                  name={policy.name}
                  pattern={policy.pattern}
                  applyTo={policy.applyTo}
                  priority={policy.priority}
                  summary={describeDefinition(policy.definition)}
                  onEdit={() => setEditing(policy)}
                  canWrite={canWrite}
                />
              ))}
            </DataTable>
          ) : (
            <Empty
              title={keyword ? "没有匹配的策略" : "还没有策略"}
              description={
                keyword
                  ? undefined
                  : "TTL、死信、长度上限、镜像这些规则通常都通过策略下发，而不是写死在客户端"
              }
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`操作员策略（${data?.operatorPolicies.length ?? 0}）`}
          extra={
            data?.operatorError ? (
              <span className="text-(length:--text-app-meta) text-amber-700">接口不可用</span>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {data?.operatorError ? (
            <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">
              拉取失败：{data.operatorError}
              <br />
              老版本 RabbitMQ（3.8 之前）没有这个接口，不影响上面的普通策略。
            </p>
          ) : data?.operatorPolicies.length ? (
            <DataTable columns={OPERATOR_POLICY_COLUMNS}>
              {data.operatorPolicies.map((policy) => (
                <OperatorPolicyRow key={policy.name} policy={policy} />
              ))}
            </DataTable>
          ) : (
            <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">
              没有操作员策略。运维可以用它兜住底线（例如禁止无限长队列），用户无法覆盖
            </p>
          )}
        </CardBody>
      </Card>

      <PolicyEditor
        open={creating || Boolean(editing)}
        policy={editing}
        canWrite={canWrite}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </PageBody>
  );
}

function PolicyRow({
  name,
  pattern,
  applyTo,
  priority,
  summary,
  canWrite,
  onEdit,
}: {
  name: string;
  pattern: string;
  applyTo: PolicyApplyTo;
  priority: number;
  summary: string;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const { connectionId } = useParams();
  const remove = useDeletePolicy(connectionId);
  const [confirming, setConfirming] = useState(false);

  const writeHint = canWrite ? undefined : "当前账号没有管理 API 写权限";

  return (
    <TableRow>
      <TableCell mono className="text-slate-800">
        {name}
      </TableCell>
      <TableCell mono muted>
        {pattern || ".*"}
      </TableCell>
      <TableCell>
        <Badge tone={APPLY_TO_TONE[applyTo]}>{APPLY_TO_LABEL[applyTo]}</Badge>
      </TableCell>
      <TableCell muted numeric>
        {priority}
      </TableCell>
      <TableCell className="font-mono text-(length:--text-app-meta) text-slate-500">{summary}</TableCell>
      <TableCell>
        <TableActions>
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite}
            title={writeHint}
            onClick={onEdit}
          >
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canWrite || remove.isPending}
            title={writeHint}
            onClick={() => setConfirming(true)}
          >
            删除
          </Button>
        </TableActions>
      </TableCell>

      {confirming ? (
        <ConfirmDialog
          open
          title="删除策略"
          danger
          loading={remove.isPending}
          confirmLabel="删除"
          description={
            <>
              删除策略 <span className="font-mono text-slate-800">{name}</span>。
              删除只是停止下发，不会动已有的消息；但已套用这条规则的队列不会退回默认值，
              除非重新声明。
            </>
          }
          onConfirm={() => remove.mutate(name, { onSettled: () => setConfirming(false) })}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </TableRow>
  );
}

/** 操作员策略只读：它由运维下发，面板不提供编辑入口。 */
function OperatorPolicyRow({ policy }: { policy: OperatorPolicyInfo }) {
  return (
    <TableRow>
      <TableCell mono className="text-slate-800">
        {policy.name}
        <span className="ml-2 font-sans text-(length:--text-app-meta) text-slate-500">只读</span>
      </TableCell>
      <TableCell mono muted>
        {policy.pattern || ".*"}
      </TableCell>
      <TableCell>
        <Badge tone={APPLY_TO_TONE[policy.applyTo]}>{APPLY_TO_LABEL[policy.applyTo]}</Badge>
      </TableCell>
      <TableCell muted numeric>
        {policy.priority}
      </TableCell>
      <TableCell className="font-mono text-(length:--text-app-meta) text-slate-500">
        {describeDefinition(policy.definition)}
      </TableCell>
    </TableRow>
  );
}
