import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Badge, Button, Card, CardBody, CardHeader, Empty, ErrorState, Field, Input, Loading, Modal, Select } from "@/components/ui";
import { useTopology } from "@/hooks/use-broker-data";
import { useHealth } from "@/hooks/use-health";
import { useCreateBinding, useCreateExchange, useDeleteBinding, useDeleteExchange } from "@/hooks/use-queue-actions";
import { errorMessage } from "@/lib/errors";
import type { BindingInfo, BindingSpec, ExchangeInfo, ExchangeKind, ExchangeSpec } from "@/types";
import type { Tone } from "@/types/tone";

/** 交换机类型对应的色调与文案，未识别类型统一按中性色展示。 */
const EXCHANGE_TONE: Record<ExchangeKind, Tone> = {
  direct: "info",
  fanout: "success",
  topic: "warning",
  headers: "neutral",
  unknown: "neutral",
};

/**
 * RabbitMQ 拓扑：交换机 + 绑定关系。
 *
 * 三张表放在同一页，是因为「消息为什么没进队列」这类问题必须同时看交换机和绑定：
 * 交换机存在但没有匹配的 binding，消息会被静默丢弃，只看队列是查不出来的。
 */
export function ExchangesPage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useTopology(connectionId, true);
  const { canWrite } = useHealth(connectionId);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [binding, setBinding] = useState(false);

  const filtered = useMemo(() => {
    if (!data) return { exchanges: [], bindings: [] };
    const needle = keyword.trim().toLowerCase();
    const match = (value: string) => !needle || value.toLowerCase().includes(needle);
    // 选中交换机时只看它的出站绑定；未选中时展示全部，方便一屏看到全貌。
    return {
      exchanges: data.exchanges.filter((item) => match(item.name)),
      bindings: data.bindings.filter(
        (item) =>
          (!selected || item.source === selected || item.destination === selected) &&
          (match(item.source) || match(item.destination) || match(item.routingKey)),
      ),
    };
  }, [data, keyword, selected]);

  if (isLoading) return <Loading />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  if (!data?.exchanges.length) {
    return (
      <Empty
        title="暂无交换机"
        description="交换机与绑定依赖 RabbitMQ 管理插件（15672 端口），请检查连接配置中的管理 API 地址"
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.currentTarget.value)}
            placeholder="按名称 / routing key 过滤"
            aria-label="过滤交换机与绑定"
          />
        </div>
        {selected ? (
          <Button size="sm" variant="secondary" onClick={() => setSelected(null)}>
            取消选中：{selected}
          </Button>
        ) : (
          <p className="text-xs text-slate-500">点击交换机行可只看它的绑定</p>
        )}
        <div className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite}
            title={canWrite ? undefined : "当前账号没有管理 API 写权限"}
            onClick={() => setBinding(true)}
          >
            新建绑定
          </Button>
          <Button
            size="sm"
            disabled={!canWrite}
            title={canWrite ? undefined : "当前账号没有管理 API 写权限"}
            onClick={() => setCreating(true)}
          >
            新建交换机
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader title={`交换机（${filtered.exchanges.length}）`} />
        <CardBody className="p-0">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2 font-normal">名称</th>
                <th className="px-4 py-2 font-normal">类型</th>
                <th className="px-4 py-2 font-normal">vhost</th>
                <th className="px-4 py-2 font-normal">入站速率</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.exchanges.map((exchange) => (
                <tr
                  key={`${exchange.vhost}/${exchange.name}`}
                  className="cursor-pointer border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40"
                  onClick={() => setSelected(exchange.name)}
                >
                  <td className="px-4 py-2 font-mono text-xs text-slate-200">
                    {exchange.name || "(默认交换机)"}
                    {exchange.internal ? <span className="ml-2 text-[11px] text-slate-500">内置</span> : null}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={EXCHANGE_TONE[exchange.exchangeType]}>{exchange.kind}</Badge>
                  </td>
                  <td className="px-4 py-2 text-slate-400">{exchange.vhost}</td>
                  <td className="px-4 py-2 text-slate-400">{formatRate(exchange)}</td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`绑定（${filtered.bindings.length}）`} />
        <CardBody className="p-0">
          {filtered.bindings.length ? (
            <table className="w-full text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-2 font-normal">源交换机</th>
                  <th className="px-4 py-2 font-normal">routing key</th>
                  <th className="px-4 py-2 font-normal">目标</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.bindings.map((binding) => (
                  <tr
                    key={bindingKey(binding)}
                    className="border-b border-slate-800/60 last:border-0"
                  >
                    <td className="px-4 py-2 font-mono text-xs text-slate-200">
                      {binding.source || "(默认交换机)"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-300">
                      {binding.routingKey || "-"}
                    </td>
                    <td className="px-4 py-2 text-slate-400">
                      <span className="mr-1.5 text-[11px] text-slate-500">
                        {binding.destinationType === "queue" ? "队列" : "交换机"}
                      </span>
                      {binding.destination}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1.5">
                        {binding.destinationType === "queue" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              navigate(
                                `/connections/${connectionId}/messages?target=${encodeURIComponent(binding.destination)}`,
                              )
                            }
                          >
                            查看消息
                          </Button>
                        ) : null}
                        <DeleteBindingButton
                          binding={binding}
                          connectionId={connectionId}
                          canWrite={canWrite}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="没有匹配的绑定" description="没有绑定意味着消息可能被交换机静默丢弃" />
          )}
        </CardBody>
      </Card>

      <CreateExchangeModal open={creating} onClose={() => setCreating(false)} />
      <CreateBindingModal
        open={binding}
        defaultSource={selected ?? data.exchanges[0]?.name ?? ""}
        exchanges={data.exchanges}
        queues={data.queues}
        onClose={() => setBinding(false)}
      />
    </div>
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
  const blocked = removalReason(exchange);

  if (blocked) {
    return (
      <Button size="sm" variant="ghost" disabled title={blocked}>
        删除
      </Button>
    );
  }

  const confirm = () => {
    if (
      !window.confirm(
        `删除交换机 ${exchange.name}？\n交换机上还有绑定时服务端会拒绝（不会连带删掉队列）。`,
      )
    )
      return;
    remove.mutate({ name: exchange.name, internal: exchange.internal });
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!canWrite || remove.isPending}
      title={canWrite ? undefined : "当前账号没有管理 API 写权限"}
      onClick={confirm}
    >
      删除
    </Button>
  );
}

/** 不可删除的原因；可删除时返回 null。 */
function removalReason(exchange: ExchangeInfo): string | null {
  if (!exchange.name) return "默认交换机由服务端隐式提供，不可删除";
  if (exchange.name.startsWith("amq.")) return "`amq.` 前缀是 RabbitMQ 保留交换机，不可删除";
  if (exchange.internal) return "内置（internal）交换机不可删除";
  return null;
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
  const isDefaultSource = !binding.source;

  const confirm = () => {
    if (!window.confirm(`解除绑定 ${binding.source || "(默认交换机)"} → ${binding.destination}？`))
      return;
    remove.mutate({
      source: binding.source,
      destination: binding.destination,
      destinationType: binding.destinationType,
      routingKey: binding.routingKey,
      arguments: binding.arguments,
    });
  };

  return (
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
      onClick={confirm}
    >
      解除
    </Button>
  );
}

/** 绑定唯一键：同一对 source/destination 可以有多条不同 routing key 的绑定。 */
function bindingKey(binding: BindingInfo): string {
  return `${binding.source}|${binding.destinationType}|${binding.destination}|${binding.routingKey}`;
}

/** 速率保留两位小数，0 直接显示为 `-`，避免一屏全是 0。 */
function formatRate(exchange: ExchangeInfo): string {
  if (!exchange.messageRate) return "-";
  return `${exchange.messageRate.toFixed(2)}/s`;
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

  const submit = () => {
    // 关掉弹窗只在成功后：失败时要保留用户填的内容，方便改完再试。
    create.mutate(spec, { onSuccess: () => onClose() });
  };

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
          <Button size="sm" disabled={create.isPending} onClick={submit}>
            创建
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={spec.durable}
            onChange={(event) => setSpec({ ...spec, durable: event.currentTarget.checked })}
          />
          持久化（broker 重启后保留）
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300">
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

const DEFAULT_EXCHANGE_SPEC: ExchangeSpec = {
  name: "",
  kind: "direct",
  durable: true,
  autoDelete: false,
};

const EXCHANGE_KIND_OPTIONS = [
  { value: "direct", label: "direct（按 routing key 精确匹配）" },
  { value: "topic", label: "topic（按模式匹配）" },
  { value: "fanout", label: "fanout（广播到全部绑定）" },
  { value: "headers", label: "headers（按消息头匹配）" },
];

/** 新建绑定弹窗。 */
function CreateBindingModal({
  open,
  defaultSource,
  exchanges,
  queues,
  onClose,
}: {
  open: boolean;
  defaultSource: string;
  exchanges: ExchangeInfo[];
  queues: { name: string }[];
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

  const submit = () => {
    create.mutate(spec, { onSuccess: () => onClose() });
  };

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
          <Button size="sm" disabled={create.isPending} onClick={submit}>
            绑定
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
            <Input
              value={spec.destination.name}
              list="binding-destinations"
              required
              placeholder={destinationKind === "queue" ? "orders.queue" : "orders.retry"}
              onChange={(event) =>
                setSpec({
                  ...spec,
                  destination: { ...spec.destination, name: event.currentTarget.value },
                })
              }
            />
            <datalist id="binding-destinations">
              {(destinationKind === "queue" ? queues : exchanges)
                .filter((item) => item.name)
                .map((item) => (
                  <option key={item.name} value={item.name} />
                ))}
            </datalist>
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
          <Input
            value={spec.routingKey}
            placeholder="order.created"
            onChange={(event) => setSpec({ ...spec, routingKey: event.currentTarget.value })}
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

function initialBinding(source: string): BindingSpec {
  return {
    source,
    destination: { name: "", kind: "queue" },
    routingKey: "",
    arguments: [],
  };
}
