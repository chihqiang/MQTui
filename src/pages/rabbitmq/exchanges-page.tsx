import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { useListFilter } from "@/hooks/use-list-filter";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ComboInput,
  ConfirmDialog,
  DataTable,
  Empty,
  ErrorState,
  Field,
  Input,
  Modal,
  RefreshButton,
  StaleNotice,
  Select,
  TableActions,
  TableCell,
  TableRow,
} from "@/components/ui";
import { FilterBar, NavigateButton } from "@/components/broker";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { useTopology } from "@/hooks/use-broker-data";
import { useHealth } from "@/hooks/use-health";
import { useCreateBinding, useCreateExchange, useDeleteBinding, useDeleteExchange } from "@/hooks/use-queue-actions";
import { messagesPath } from "@/lib/actions";
import { errorMessage } from "@/lib/errors";
import {
  DEFAULT_EXCHANGE_SPEC,
  bindingKey,
  filterTopology,
  formatRate,
  initialBinding,
  removalReason,
} from "@/lib/exchange";
import { failureText } from "@/lib/failure";
import {
  BINDING_COLUMNS,
  EXCHANGE_COLUMNS,
  EXCHANGE_KIND_OPTIONS,
  EXCHANGE_KIND_TONE,
} from "@/types/exchange";
import type { BindingInfo, BindingSpec, ExchangeInfo, ExchangeSpec } from "@/types";

/**
 * RabbitMQ 拓扑：交换机 + 绑定关系。
 *
 * 三张表放在同一页，是因为「消息为什么没进队列」这类问题必须同时看交换机和绑定：
 * 交换机存在但没有匹配的 binding，消息会被静默丢弃，只看队列是查不出来的。
 */
export function ExchangesPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useTopology(connectionId, true);
  const { canWrite } = useHealth(connectionId);
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [binding, setBinding] = useState(false);

  const filtered = useMemo(() => {
    if (!data) return { exchanges: [], bindings: [] };
    // 选中交换机时只看它的出站绑定；未选中时展示全部，方便一屏看到全貌。
    return filterTopology(data, keyword, selected);
  }, [data, keyword, selected]);

  if (error && !data?.exchanges.length) {
    return (
      <ErrorState
        message={failureText("读取交换机与绑定", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!isLoading && !data?.exchanges.length) {
    return (
      <Empty
        title="暂无交换机"
        description="交换机与绑定依赖 RabbitMQ 管理插件（15672 端口），请检查连接配置中的管理 API 地址"
      />
    );
  }

  const writeHint = canWrite ? undefined : "当前账号没有管理 API 写权限";

  return (
    <PageBody>
      <PageHeader
        title="交换机与绑定"
        description="交换机存在但没有匹配的 binding 时，消息会被静默丢弃 —— 这两张表要一起看"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data?.exchanges.length ? (
        <StaleNotice
          message={failureText("刷新交换机与绑定", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      <PageToolbar
        hint={selected ? undefined : "点击交换机行可只看它的绑定"}
        actions={
          <>
            {selected ? (
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                取消选中：{selected}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite || isLoading}
              title={writeHint}
              onClick={() => setBinding(true)}
            >
              新建绑定
            </Button>
            <Button
              size="sm"
              disabled={!canWrite || isLoading}
              title={writeHint}
              onClick={() => setCreating(true)}
            >
              新建交换机
            </Button>
          </>
        }
      >
        <FilterBar
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按名称 / routing key 过滤"
          ariaLabel="过滤交换机与绑定"
        />
      </PageToolbar>

      <Card>
        <CardHeader
          title={`交换机（${isLoading ? "…" : filtered.exchanges.length}）`}
          extra={
            selected ? (
              <span className="text-(length:--text-app-meta) text-slate-500">下面只显示与它相关的绑定</span>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          <DataTable columns={EXCHANGE_COLUMNS} loadingRows={isLoading ? 6 : undefined}>
            {filtered.exchanges.map((exchange) => (
              <TableRow
                key={`${exchange.vhost}/${exchange.name}`}
                clickable
                onClick={() => setSelected(exchange.name)}
              >
                <TableCell mono className="text-slate-800">
                  {exchange.name || "(默认交换机)"}
                  {exchange.internal ? (
                    <span className="ml-2 font-sans text-(length:--text-app-meta) text-slate-500">内置</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge tone={EXCHANGE_KIND_TONE[exchange.exchangeType] ?? "neutral"}>{exchange.kind}</Badge>
                </TableCell>
                <TableCell muted>{exchange.vhost}</TableCell>
                <TableCell muted numeric>
                  {formatRate(exchange)}
                </TableCell>
                <TableCell>
                  <TableActions>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="复制交换机名"
                      onClick={(event) => {
                        event.stopPropagation();
                        void navigator.clipboard?.writeText(exchange.name);
                      }}
                    >
                      复制
                    </Button>
                    <DeleteExchangeButton
                      exchange={exchange}
                      connectionId={connectionId}
                      canWrite={canWrite}
                    />
                  </TableActions>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`绑定（${isLoading ? "…" : filtered.bindings.length}）`} />
        <CardBody className="p-0">
          {isLoading || filtered.bindings.length ? (
            <DataTable columns={BINDING_COLUMNS} loadingRows={isLoading ? 4 : undefined}>
              {filtered.bindings.map((binding) => (
                <TableRow key={bindingKey(binding)}>
                  <TableCell mono className="text-slate-800">
                    {binding.source || "(默认交换机)"}
                  </TableCell>
                  <TableCell mono className="text-slate-600">
                    {binding.routingKey || "-"}
                  </TableCell>
                  <TableCell muted>
                    <span className="mr-1.5 text-(length:--text-app-meta) text-slate-500">
                      {binding.destinationType === "queue" ? "队列" : "交换机"}
                    </span>
                    {binding.destination}
                  </TableCell>
                  <TableCell>
                    <TableActions>
                      {binding.destinationType === "queue" ? (
                        <NavigateButton to={messagesPath(connectionId, binding.destination)}>
                          查看消息
                        </NavigateButton>
                      ) : null}
                      <DeleteBindingButton
                        binding={binding}
                        connectionId={connectionId}
                        canWrite={canWrite}
                      />
                    </TableActions>
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          ) : (
            <Empty title="没有匹配的绑定" description="没有绑定意味着消息可能被交换机静默丢弃" />
          )}
        </CardBody>
      </Card>

      <CreateExchangeModal open={creating} onClose={() => setCreating(false)} />
      <CreateBindingModal
        open={binding}
        defaultSource={selected ?? data?.exchanges[0]?.name ?? ""}
        exchanges={data?.exchanges ?? []}
        queues={data?.queues ?? []}
        bindings={data?.bindings ?? []}
        onClose={() => setBinding(false)}
      />
    </PageBody>
  );
}

/**
 * 删除交换机。可删性规则与后端 `ExchangeRemoval` 保持一致：
 * 默认交换机、`amq.` 保留命名、内置交换机一律不给按钮。
 */
function DeleteExchangeButton({
  exchange,
  connectionId,
  canWrite,
}: {
  exchange: ExchangeInfo;
  connectionId: string | undefined;
  canWrite: boolean;
}) {
  const remove = useDeleteExchange(connectionId);
  const [confirming, setConfirming] = useState(false);
  const blocked = removalReason(exchange);

  if (blocked) {
    return (
      <Button size="sm" variant="ghost" disabled title={blocked}>
        删除
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!canWrite || remove.isPending}
        title={canWrite ? undefined : "当前账号没有管理 API 写权限"}
        onClick={() => setConfirming(true)}
      >
        删除
      </Button>
      <ConfirmDialog
        open={confirming}
        title="删除交换机"
        danger
        loading={remove.isPending}
        confirmLabel="删除"
        description={
          <>
            交换机 <span className="font-mono text-slate-800">{exchange.name}</span> 上的绑定会被
            服务端拒绝删除（不会连带删掉队列）。确认已无发布方在使用。
          </>
        }
        onConfirm={() =>
          remove.mutate(
            { name: exchange.name, internal: exchange.internal },
            { onSettled: () => setConfirming(false) },
          )
        }
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * 删除绑定。
 *
 * 默认交换机上的绑定不能删：这些「绑定」在 AMQP 里是隐式的（队列名即 routing key），
 * 服务端根本不保存记录，删了也不会有任何变化。
 */
function DeleteBindingButton({
  binding,
  connectionId,
  canWrite,
}: {
  binding: BindingInfo;
  connectionId: string | undefined;
  canWrite: boolean;
}) {
  const remove = useDeleteBinding(connectionId);
  const [confirming, setConfirming] = useState(false);
  const isDefaultSource = !binding.source;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!canWrite || isDefaultSource || remove.isPending}
        title={
          isDefaultSource
            ? "默认交换机的绑定由服务端隐式维护，不能单独删除"
            : canWrite
              ? undefined
              : "当前账号没有管理 API 写权限"
        }
        onClick={() => setConfirming(true)}
      >
        解除
      </Button>
      <ConfirmDialog
        open={confirming}
        title="解除绑定"
        danger
        loading={remove.isPending}
        confirmLabel="解除"
        description={
          <>
            解除{" "}
            <span className="selectable font-mono text-slate-800">
              {binding.source || "(默认交换机)"} → {binding.destination}
            </span>{" "}
            （routing key <span className="font-mono">{binding.routingKey || "(空)"}</span>）。
            解除后匹配这条规则的发布消息将不再进入目标队列。
          </>
        }
        onConfirm={() =>
          remove.mutate(
            {
              source: binding.source,
              destination: binding.destination,
              destinationType: binding.destinationType,
              routingKey: binding.routingKey,
              arguments: binding.arguments,
            },
            { onSettled: () => setConfirming(false) },
          )
        }
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** 新建交换机弹窗。类型限定在 AMQP 内置的四种，其余留给服务端插件自己注册。 */
function CreateExchangeModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const create = useCreateExchange(connectionId);
  const [spec, setSpec] = useState<ExchangeSpec>(DEFAULT_EXCHANGE_SPEC);


  return (
    <Modal
      open={open}
      title="新建交换机"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>
            取消
          </Button>
          {/* 关掉弹窗只在成功后：失败时要保留用户填的内容，方便改完再试。 */}
          <Button
            size="sm"
            loading={create.isPending}
            onClick={() => create.mutate(spec, { onSuccess: () => onClose() })}
          >
            创建
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // 关掉弹窗只在成功后：失败时要保留用户填的内容，方便改完再试。
          create.mutate(spec, { onSuccess: () => onClose() });
        }}
      >
        <Field label="名称">
          <Input
            value={spec.name}
            placeholder="orders.exchange"
            required
            onChange={(event) => setSpec({ ...spec, name: event.currentTarget.value })}
          />
        </Field>
        <Field label="类型">
          <Select
            value={spec.kind}
            onChange={(event) => setSpec({ ...spec, kind: event.currentTarget.value })}
          >
            {EXCHANGE_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-(length:--text-app-body) text-slate-600">
          <input
            type="checkbox"
            checked={spec.durable}
            onChange={(event) => setSpec({ ...spec, durable: event.currentTarget.checked })}
          />
          持久化（broker 重启后保留）
        </label>
        <label className="flex items-center gap-2 text-(length:--text-app-body) text-slate-600">
          <input
            type="checkbox"
            checked={spec.autoDelete}
            onChange={(event) => setSpec({ ...spec, autoDelete: event.currentTarget.checked })}
          />
          自动删除（最后一个绑定解除后消失）
        </label>
      </form>
    </Modal>
  );
}

/** 新建绑定弹窗。 */
function CreateBindingModal({
  open,
  defaultSource,
  exchanges,
  queues,
  bindings,
  onClose,
}: {
  open: boolean;
  defaultSource: string;
  exchanges: ExchangeInfo[];
  queues: { name: string }[];
  /** 已有绑定：routing key 的候选来自这里，不是凭空猜的。 */
  bindings: BindingInfo[];
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const create = useCreateBinding(connectionId);
  // 弹窗是常驻组件，只有 visible 变化时重置表单：默认来源跟随当前选中的交换机。
  const [spec, setSpec] = useState<BindingSpec>(initialBinding(defaultSource));
  useEffect(() => {
    if (open) setSpec(initialBinding(defaultSource));
  }, [open, defaultSource]);

  const sourceKind = exchanges.find((item) => item.name === spec.source)?.exchangeType;
  const isHeaders = sourceKind === "headers";
  const destinationKind = spec.destination.kind;


  return (
    <Modal
      open={open}
      title="新建绑定"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            loading={create.isPending}
            onClick={() => create.mutate(spec, { onSuccess: () => onClose() })}
          >
            绑定
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // 关掉弹窗只在成功后：失败时要保留用户填的内容，方便改完再试。
          create.mutate(spec, { onSuccess: () => onClose() });
        }}
      >
        <Field label="源交换机" hint="留空表示默认交换机（按队列名直投）">
          <Select
            value={spec.source}
            onChange={(event) => setSpec({ ...spec, source: event.currentTarget.value })}
          >
            <option value="">(默认交换机)</option>
            {exchanges
              .filter((item) => item.name)
              .map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="目标类型">
            <Select
              value={destinationKind}
              disabled={!spec.source}
              onChange={(event) =>
                setSpec({
                  ...spec,
                  destination: {
                    ...spec.destination,
                    kind: event.currentTarget.value as BindingSpec["destination"]["kind"],
                    // 默认交换机只能绑队列，切换类型后旧名称不再是合法目标。
                    name: "",
                  },
                })
              }
            >
              <option value="queue">队列</option>
              <option value="exchange">交换机</option>
            </Select>
          </Field>
          <Field label={destinationKind === "queue" ? "目标队列" : "目标交换机"}>
            {/*
              目标名一律从现有资源里挑：绑定一个不存在的目标，管理 API 会建成功
              （有些版本还会顺手把队列建出来），错在哪要到消息发不出去时才发现。
              候选之外仍可手输 —— 交换机可以先建绑定、再建目标。
            */}
            <ComboInput
              value={spec.destination.name}
              choices={(destinationKind === "queue" ? queues : exchanges)
                .filter((item) => item.name)
                .map((item) => ({ value: item.name, hint: destinationKind === "queue" ? undefined : "交换机" }))}
              required
              placeholder={destinationKind === "queue" ? "orders.queue" : "orders.retry"}
              onValueChange={(name) =>
                setSpec({ ...spec, destination: { ...spec.destination, name } })
              }
            />
          </Field>
        </div>

        <Field
          label="routing key"
          hint={
            isHeaders
              ? "headers 交换机不按 routing key 匹配，留空即可"
              : "topic 支持 * 与 # 通配；fanout 忽略此项"
          }
        >
          {/*
            routing key 的候选只取**同一个源交换机**上已经配过的那些：
            跨交换机混在一起没有意义，`orders.*` 挂在 `orders.exchange` 上才是它的语义。
          */}
          <ComboInput
            value={spec.routingKey}
            choices={[
              ...new Set(
                bindings
                  .filter((item) => item.routingKey && item.source === spec.source)
                  .map((item) => item.routingKey),
              ),
            ]}
            placeholder="order.created"
            onValueChange={(routingKey) => setSpec({ ...spec, routingKey })}
          />
        </Field>

        {isHeaders ? (
          <Field label="x-match" hint="all 表示全部头匹配，any 表示任意一个匹配">
            <Select
              value={spec.arguments?.[0]?.value ?? "all"}
              onChange={(event) =>
                setSpec({
                  ...spec,
                  arguments: [{ key: "x-match", value: event.currentTarget.value }],
                })
              }
            >
              <option value="all">all</option>
              <option value="any">any</option>
            </Select>
          </Field>
        ) : null}
      </form>
    </Modal>
  );
}

