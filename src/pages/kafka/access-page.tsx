import { useState } from "react";
import { useParams } from "react-router";

import {
  AclEntryEditor,
  AclPrincipalTable,
  AclTable,
  QuotaTable,
  ScramTable,
} from "@/components/broker";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorState,
  RefreshButton,
  SearchInput,
  Segmented,
  Select,
} from "@/components/ui";
import { useAcls } from "@/hooks/use-acls";
import { useQuotas, useScramCredentials } from "@/hooks/use-quota";
import {
  aclVerdict,
  blankEntry,
  byPrincipal,
  filterChips,
  filterEntries,
  invertPermission,
  isFilterEmpty,
  selfLockRisks,
  ACL_OPERATION_OPTIONS,
  ACL_PERMISSION_OPTIONS,
  ACL_RESOURCE_TYPES,
} from "@/lib/acl";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { IconClose } from "@/lib/icons";
import {
  groupQuotas,
  partialUsers,
  quotaEmptyTitle,
  quotaVerdict,
  scramReadable,
  scramVerdictOf,
} from "@/lib/quota";
import {
  ACL_OPERATION_LABEL,
  ACL_PERMISSION_LABEL,
  ACL_RESOURCE_LABEL,
  type AclEntry,
  type AclFilter,
  type AclOperation,
  type AclPermission,
  type AclResourceType,
} from "@/types/acl";

/**
 * Kafka 准入页：ACL + 客户端配额 + SASL/SCRAM 凭据。
 *
 * 这一屏回答三个准入问题：**谁被允许做什么**、**谁被限速了**、**谁能连上**。
 * 三块分开查询，因为失败面完全不同 —— 配额读不到是常态（librdkafka 未导出
 * `DescribeClientQuotas`），SCRAM 读不到要么是权限、要么是版本，ACL 读不到
 * 则是「没开授权器」。合成一个查询，一个失败会把其他栏也拖成错误态。
 *
 * 配额与 SCRAM 凭据只读：librdkafka 只导出了查，没导出 `AlterClientQuotas` /
 * `AlterUserScramCredentials`。
 *
 * ACL 可以写（librdkafka 2.12 里 `CreateAcls` / `DeleteAcls` 都在），但走的是
 * **预演 → 手打主体名 → 提交** 这条路。写错一条 ACL 是授权事故：多一条是
 * 「谁能进来」，少一条是「谁掉线」，而服务端对这两种错误都不会有任何反馈。
 * 所以这一屏的重点不在「把请求发出去」，而在发之前把「会发生什么」摆出来。
 */
export function AccessPage() {
  const { connectionId } = useParams();
  const quotas = useQuotas(connectionId);
  const scram = useScramCredentials(connectionId);

  // 过滤条件只留在本地：「名字含」「主体含」是包含匹配，服务端只做精确匹配。
  const [filter, setFilter] = useState<AclFilter>({});
  const [aclView, setAclView] = useState<"principal" | "flat">("principal");
  // 写入口：新建一条空规则，或者从现有规则派生「删掉 / 翻权限」。
  const [editing, setEditing] = useState<{ entry: AclEntry; mode: "create" | "delete" } | null>(
    null,
  );
  const acls = useAcls(connectionId, filter);

  const chips = filterChips(filter);
  const visible = filterEntries(acls.data?.entries ?? [], filter);
  const groups = byPrincipal(visible);
  const risks = acls.data ? selfLockRisks(acls.data) : [];

  return (
    <PageBody>
      <PageHeader
        title="准入"
        description="谁被允许做什么、谁被限速、谁能连上；ACL 可写（先预演），配额与凭据只读，改动请用 kafka-configs.sh"
        actions={
          <RefreshButton
            state={{
              firstLoad: !quotas.data && !scram.data && !acls.data,
              refreshing: quotas.isFetching || scram.isFetching || acls.isFetching,
              hasData: Boolean(quotas.data) || Boolean(scram.data) || Boolean(acls.data),
            }}
            onRefresh={() => {
              void quotas.refetch();
              void scram.refetch();
              void acls.refetch();
            }}
          />
        }
      />

      {risks.length ? (
        // 自锁 ACL 要排在所有表格前面：真出现时，面板「什么都读不到」看起来像 bug。
        <Callout tone="danger">
          有 {risks.length} 条集群级拒绝规则可能把你自己也挡在外面：
          {risks.map((entry) => ` ${entry.principal}`).join("、")} 被拒了 DESCRIBE。
          这类规则一落地，连读 ACL 本身都会失败 —— 先确认自己的账号在不在里面。
        </Callout>
      ) : null}

      <Card>
        <CardHeader
          title="ACL 规则"
          extra={
            <div className="flex items-center gap-2">
              {acls.data ? <span className="text-meta">{aclVerdict(acls.data)}</span> : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(acls.data?.unsupported)}
                onClick={() => setEditing({ entry: blankEntry(), mode: "create" })}
              >
                新建规则
              </Button>
            </div>
          }
        />
        <CardBody className="flex flex-col gap-2.5">
          {/* 第一层是筛法，第二层只留命中情况：「筛了什么」和「筛出什么」
              放在同一行时，用户改一个下拉就要重新找一遍计数。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <AclFilterSelect
              label="资源类型"
              value={filter.resourceType ?? ""}
              anyLabel="全部资源"
              options={ACL_RESOURCE_TYPES.map((kind) => ({
                value: kind,
                label: ACL_RESOURCE_LABEL[kind],
              }))}
              onChange={(value) =>
                setFilter((current) => ({
                  ...current,
                  resourceType: value ? (value as AclResourceType) : undefined,
                }))
              }
            />
            <AclFilterSelect
              label="操作"
              value={filter.operation ?? ""}
              anyLabel="全部操作"
              options={ACL_OPERATION_OPTIONS.map((operation) => ({
                value: operation,
                label: ACL_OPERATION_LABEL[operation],
              }))}
              onChange={(value) =>
                setFilter((current) => ({
                  ...current,
                  operation: value ? (value as AclOperation) : undefined,
                }))
              }
            />
            <AclFilterSelect
              label="权限"
              value={filter.permission ?? ""}
              anyLabel="允许与拒绝"
              options={ACL_PERMISSION_OPTIONS.map((permission) => ({
                value: permission,
                label: ACL_PERMISSION_LABEL[permission],
              }))}
              onChange={(value) =>
                setFilter((current) => ({
                  ...current,
                  permission: value ? (value as AclPermission) : undefined,
                }))
              }
            />
            <SearchInput
              value={filter.principal ?? ""}
              onValueChange={(value) =>
                setFilter((current) => ({ ...current, principal: value || undefined }))
              }
              icon
              placeholder="主体含…"
              className="w-40"
              aria-label="按主体筛选"
            />
            <SearchInput
              value={filter.resourceName ?? ""}
              onValueChange={(value) =>
                setFilter((current) => ({ ...current, resourceName: value || undefined }))
              }
              icon
              placeholder="资源名含…"
              className="w-40"
              aria-label="按资源名筛选"
            />
            <Segmented
              className="ml-auto"
              value={aclView}
              onChange={(value) => setAclView(value as "principal" | "flat")}
              options={[
                { value: "principal", label: "按主体", title: "同一个人能做的事放在一块" },
                { value: "flat", label: "逐条", title: "一行一条规则，主体每行都写" },
              ]}
            />
          </div>

          {/* 过滤后的表最容易被误读成全量，所以只要筛了就把它说出来 ——
              而且每条都能就地摘掉。以前只有一句「筛选中 · 命中 0 / 0 条」，
              在空表上唯一能做的是回去把下拉挨个点回「全部」。 */}
          <div className="flex min-h-6 flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-meta">
              {isFilterEmpty(filter) ? "全部规则" : "筛选中"}
              {acls.data ? ` · 命中 ${visible.length} / ${acls.data.entries.length} 条` : ""}
            </span>
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFilter((current) => ({ ...current, [chip.key]: undefined }))}
                className="group inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1.5 pl-2 text-meta text-slate-700 transition-colors hover:bg-slate-200"
                aria-label={`去掉筛选：${chip.text}`}
              >
                {chip.text}
                <IconClose size={10} className="text-slate-400 group-hover:text-slate-700" />
              </button>
            ))}
            {chips.length > 1 ? (
              <button
                type="button"
                onClick={() => setFilter({})}
                className="rounded px-1 text-meta text-indigo-700 transition-colors hover:bg-indigo-50"
              >
                全部清掉
              </button>
            ) : null}
          </div>

          {acls.error && !acls.data ? (
            <ErrorState
              message={failureText("读取 ACL", errorMessage(acls.error))}
              onRetry={() => void acls.refetch()}
            />
          ) : acls.data?.unsupported ? (
            // 「不支持」不是空表：空表读起来是「对所有人敞开」，那是另一个结论。
            <Callout tone="info">{acls.data.unsupported}</Callout>
          ) : acls.isLoading ? (
            <AclTable entries={[]} loading />
          ) : visible.length === 0 ? (
            <Empty
              title={acls.data?.entries.length ? "没有匹配的规则" : "没有任何 ACL 规则"}
              description={
                acls.data?.entries.length
                  ? "换个筛选条件试试；这里只做包含匹配，不区分大小写"
                  : "集群没有配置授权器时，任何操作都不会被 ACL 拦截"
              }
              // 空表上最该有的按钮就是「把筛选清掉」：它比让用户回去
              // 把三个下拉逐个点回「全部」近得多。
              action={
                acls.data?.entries.length && !isFilterEmpty(filter) ? (
                  <Button size="sm" variant="ghost" onClick={() => setFilter({})}>
                    清掉筛选，显示全部 {acls.data.entries.length} 条
                  </Button>
                ) : undefined
              }
            />
          ) : aclView === "principal" ? (
            <AclPrincipalTable
              groups={groups}
              onDelete={(entry) => setEditing({ entry, mode: "delete" })}
              onInvert={(entry) => setEditing({ entry: invertPermission(entry), mode: "create" })}
            />
          ) : (
            <AclTable
              entries={visible}
              onDelete={(entry) => setEditing({ entry, mode: "delete" })}
              onInvert={(entry) => setEditing({ entry: invertPermission(entry), mode: "create" })}
            />
          )}

          {acls.data?.notes.length ? (
            <div className="flex flex-col gap-1">
              {acls.data.notes.map((note) => (
                <p key={note} className="text-meta">
                  {note}
                </p>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

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

      <AclEntryEditor
        open={Boolean(editing)}
        draft={editing?.entry ?? null}
        mode={editing?.mode ?? "create"}
        onClose={() => {
          setEditing(null);
          void acls.refetch();
        }}
      />

      <Card>
        <CardHeader title="为什么配额与凭据仍然只读" />
        <CardBody className="flex flex-col gap-2">
          <p className="text-(length:--text-app-body) text-slate-700">
            配额和凭据是「根本改不了」：librdkafka 2.12 只导出了查，没有导出
            <span className="mx-1 font-mono">AlterClientQuotas</span>
            与
            <span className="mx-1 font-mono">AlterUserScramCredentials</span>
            。
          </p>
          <p className="text-(length:--text-app-body) text-slate-700">
            ACL 不一样：librdkafka 里
            <span className="mx-1 font-mono">CreateAcls</span>
            /
            <span className="mx-1 font-mono">DeleteAcls</span>
            都在，所以这一栏可以写。但写入口刻意做成了三步：
            <span className="mx-1 font-mono">预演</span>说清会新增什么、和谁冲突；
            有风险时勾一个「我知道」；
            <span className="mx-1 font-mono">提交</span>要求手打主体名。
          </p>
          <p className="text-(length:--text-app-body) text-slate-700">
            提交不复用预演结果 —— 确认框可能开着几十秒，期间别人可能刚改过 ACL。
            后端在提交时重新读一遍全部规则再算。
          </p>
          <p className="text-meta">
            半吊子的写入按钮比没有更糟：它会让人以为改成功了，直到下一次认证失败。
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">ACL 可写（先预演）</Badge>
            <Badge tone="neutral">配额 / 凭据只读</Badge>
            <Badge tone="neutral">kafka-configs.sh --alter</Badge>
          </div>
        </CardBody>
      </Card>
    </PageBody>
  );
}

/**
 * 筛选条上的一个下拉。
 *
 * 三处与裸 `Select` 不同的地方，都是为了「一排控件看起来是一组」：
 * - 宽度按最长选项定死，三个下拉等宽；按内容自适应的话，切一次值整个条会重排；
 * - 「不过滤」那一项写成 `全部资源 / 全部操作 / 允许与拒绝`，标签就落在选项里，
 *   不再另起一行 `<label>` —— 一行三个标签加三个下拉，高度直接翻倍；
 * - 选中了就把边框和字色压深一档。不选和选了长得一样时，用户得点开才知道
 *   自己筛没筛。
 */
function AclFilterSelect({
  label,
  value,
  anyLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  anyLabel: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <Select
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      aria-label={label}
      className={cn(
        "h-8 w-32 py-0",
        value ? "border-slate-300 font-medium text-slate-900" : "text-slate-600",
      )}
    >
      <option value="">{anyLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
