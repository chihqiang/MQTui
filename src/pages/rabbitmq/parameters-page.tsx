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
import { useHealth } from "@/hooks/use-health";
import { useDeleteParameter, useParameters } from "@/hooks/use-parameters";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import {
  COMPONENT_OPTIONS,
  componentLabel,
  dialsOut,
  filterParameters,
  groupByComponent,
} from "@/lib/parameter";
import type { ParameterComponent, ParameterInfo } from "@/types/parameter";

import { ParameterEditor } from "@/pages/rabbitmq/parameter-editor";

const PARAMETER_COLUMNS: DataTableColumn[] = [
  { key: "name", label: "名称" },
  { key: "vhost", label: "vhost", width: "w-32" },
  { key: "summary", label: "摘要" },
  { key: "actions", label: <span className="sr-only">操作</span>, width: "w-32", align: "right" },
];

/**
 * RabbitMQ 参数页：联邦（federation）、铲子（shovel）、运行时参数。
 *
 * 和策略页的关键区别：策略写错是「规则不生效」，参数写错是「组件连不上」。
 * 两类失败服务端都不会主动告诉你，所以这一页的重点是：
 * - 按组件分开摆，别把 cluster_name 和铲子混在一张表里；
 * - 联邦 / 铲子的地址在列表里就把口令打码，截图外发不至于漏口令；
 * - 未配置管理 API 时直接报错，不返回空列表。
 */
export function ParametersPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useParameters(connectionId);
  const { canWrite } = useHealth(connectionId);
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  const [editing, setEditing] = useState<ParameterInfo | null>(null);
  const [creating, setCreating] = useState(false);

  // 连接摘要只记 endpoint，不带 vhost，所以新建时的默认 vhost 一律按 `/`；
  // 业务 vhost 由用户在表单里改，运行时参数则会被编辑器强制拨回 `/`。
  const defaultVhost = "/";

  const filtered = useMemo(
    () => filterParameters(data?.parameters ?? [], keyword),
    [data, keyword],
  );
  const groups = useMemo(() => groupByComponent(filtered), [filtered]);

  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取参数", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  // 和策略页一致：没配管理 API 时说清楚出路，而不是展示「0 条参数」。
  if (!data && !isLoading) {
    return (
      <Empty
        title="参数需要 RabbitMQ 管理插件"
        description="请在连接配置里填写管理 API 地址（默认 15672 端口），否则无法读取或下发参数"
      />
    );
  }

  const writeHint = canWrite ? undefined : "当前账号没有管理 API 写权限";

  return (
    <PageBody>
      <PageHeader
        title="参数"
        description="联邦、铲子与运行时参数；配错不会报错，只会让组件连不上"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新参数", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      <PageToolbar
        hint="参数是组件自己的运行配置，不像策略那样有优先级：同名即覆盖"
        actions={
          <Button
            size="sm"
            disabled={!canWrite || isLoading}
            title={writeHint}
            onClick={() => setCreating(true)}
          >
            新建参数
          </Button>
        }
      >
        <SearchInput
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按名称 / vhost / 值过滤"
          aria-label="过滤参数"
          icon
          box="page"
          className="w-64"
        />
      </PageToolbar>

      {!data?.componentFilterSupported ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-(length:--text-app-body) text-amber-800">
          当前管理 API 不支持按组件过滤参数，部分组件可能读不到。老版本 RabbitMQ 需要升级管理插件。
        </p>
      ) : null}

      {/* 权限不足 / 插件未启用只影响对应那一块，不该整页报错。 */}
      {data?.errors.length ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-(length:--text-app-body) text-slate-500">
          {data.errors.map((item) => (
            <p key={item.component}>
              <span className="text-slate-600">{componentLabel(item.component)}</span> 读取失败：
              {item.message}
            </p>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <Card>
          <CardBody className="p-0">
            <DataTable columns={PARAMETER_COLUMNS} loadingRows={6} />
          </CardBody>
        </Card>
      ) : groups.length ? (
        groups.map((group) => (
          <ParameterCard
            key={group.component}
            component={group.component}
            items={group.items}
            canWrite={canWrite}
            onEdit={setEditing}
          />
        ))
      ) : (
        <Empty
          title={keyword ? "没有匹配的参数" : "还没有参数"}
          description={
            keyword
              ? undefined
              : "联邦（跨 broker 拉消息）与铲子（把消息搬到另一个地址）都靠参数配置；簇名这类节点级设置也在这里"
          }
        />
      )}

      <ParameterEditor
        open={creating || Boolean(editing)}
        parameter={editing}
        defaultVhost={defaultVhost}
        canWrite={canWrite}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
    </PageBody>
  );
}

function ParameterCard({
  component,
  items,
  canWrite,
  onEdit,
}: {
  component: string;
  items: ParameterInfo[];
  canWrite: boolean;
  onEdit: (parameter: ParameterInfo) => void;
}) {
  const option = COMPONENT_OPTIONS.find((item) => item.value === component);
  return (
    <Card>
      <CardHeader
        title={`${componentLabel(component)}（${items.length}）`}
        extra={
          dialsOut(component) ? (
            <Badge tone="warning">会主动拨号</Badge>
          ) : undefined
        }
      />
      <CardBody className="p-0">
        {option ? (
          <p className="border-b border-slate-200 px-4 py-2 text-(length:--text-app-meta) text-slate-500">
            {option.hint}
          </p>
        ) : null}
        <DataTable columns={PARAMETER_COLUMNS}>
          {items.map((parameter) => (
            <ParameterRow
              key={`${parameter.component}@${parameter.vhost}#${parameter.name}`}
              parameter={parameter}
              canWrite={canWrite}
              onEdit={() => onEdit(parameter)}
            />
          ))}
        </DataTable>
      </CardBody>
    </Card>
  );
}

/** 摘要只取最要紧的一两个字段，完整 JSON 留在编辑弹窗里看。 */
function summarize(parameter: ParameterInfo): string {
  const value = parameter.value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["uri", "src-uri", "dest-uri", "prefetch-count", "value"]) {
      if (record[key] !== undefined) parts.push(`${key}=${renderPart(record[key])}`);
    }
    if (parts.length) return parts.join(" · ");
  }
  return JSON.stringify(value ?? null);
}

function renderPart(value: unknown): string {
  if (typeof value === "string") return maskCredentials(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  return JSON.stringify(value);
}

/**
 * URI 里的口令打码。
 *
 * 后端也做了一遍（`domain::parameter::redact_uri`），这里再做一次是因为
 * 摘要文本会直接进 DOM，多一处兜底不吃亏——漏一次就是把口令印在屏幕上。
 */
function maskCredentials(uri: string): string {
  const match = /^([a-z+]+:\/\/)([^@/]+)@(.+)$/i.exec(uri);
  if (!match) return uri;
  const [, scheme, userinfo, rest] = match;
  const user = userinfo.split(":")[0];
  return userinfo.includes(":") ? `${scheme}${user}:***@${rest}` : uri;
}

function ParameterRow({
  parameter,
  canWrite,
  onEdit,
}: {
  parameter: ParameterInfo;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const { connectionId } = useParams();
  const remove = useDeleteParameter(connectionId);
  const [confirming, setConfirming] = useState(false);

  const warning = dialsOut(parameter.component)
    ? "删除后这条联邦 / 铲子会停止工作，源端的消息仍在堆积，界面上不会报错。"
    : "删除后立刻失效，相关节点行为退回默认值。";

  const confirm = () => {
    remove.mutate(
      {
        component: parameter.component as ParameterComponent,
        vhost: parameter.vhost,
        name: parameter.name,
      },
      { onSettled: () => setConfirming(false) },
    );
  };

  const writeHint = canWrite ? undefined : "当前账号没有管理 API 写权限";

  return (
    <TableRow>
      <TableCell mono className="text-slate-800">
        {parameter.name}
      </TableCell>
      <TableCell mono muted>
        {parameter.vhost || "/"}
      </TableCell>
      <TableCell className="font-mono text-(length:--text-app-meta) text-slate-500">{summarize(parameter)}</TableCell>
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
          title="删除参数"
          danger
          loading={remove.isPending}
          confirmLabel="删除"
          description={
            <>
              删除参数 <span className="font-mono text-slate-800">{parameter.name}</span>。
              {warning}
            </>
          }
          onConfirm={confirm}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </TableRow>
  );
}
