import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { Badge, Button, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import { useOpenConnection } from "@/hooks/use-connections";
import { usePluginKinds } from "@/hooks/use-plugin-kinds";
import { BROKER_LABEL } from "@/lib/nav";
import {
  clearDraft,
  getSavedConnection,
  listSavedConnections,
  type SavedConnection,
} from "@/lib/session-storage";
import type { BrokerKind, ConnectionConfig, SaslMechanism, TlsMode } from "@/types";

import { ConnectionFormKafka } from "./forms/kafka-form";
import { ConnectionFormRabbitMq } from "./forms/rabbitmq-form";
import { SavedConnectionsCard } from "@/pages/connection/saved-connections";

/** 首页：选择中间件并建立连接。 */
export function ConnectPage() {
  const { data: plugins } = usePluginKinds();
  const [kind, setKind] = useState<BrokerKind>("kafka");
  const [name, setName] = useState("");
  const [save, setSave] = useState(false);
  // 已保存列表是 localStorage 而非服务端数据，用一次读取 + 手动刷新保持简单。
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  const openConnection = useOpenConnection();
  const [searchParams, setSearchParams] = useSearchParams();

  const submit = (config: ConnectionConfig) => {
    openConnection.mutate(
      { name: name || defaultName(config), config, save },
      {
        onSuccess: () => {
          // 连上了就说明配置有效，草稿没用了，清掉免得下次残留半成品。
          clearDraft(config.kind);
          setSaved(listSavedConnections());
        },
      },
    );
  };

  const useSaved = useCallback((entry: SavedConnection) => {
    setKind(entry.config.kind);
    setName(entry.name);
    openConnection.mutate({ name: entry.name, config: entry.config });
  }, [openConnection]);

  // `?resume=<id>` 来自「连接不存在」页的重连按钮：自动带上已保存的配置再连一次。
  const resumeId = searchParams.get("resume");
  const pendingResume = resumeId ? getSavedConnection(resumeId) : null;
  useEffect(() => {
    if (!pendingResume) return;
    setSearchParams({}, { replace: true });
    openConnection.mutate({ name: pendingResume.name, config: pendingResume.config });
  }, [pendingResume, openConnection, setSearchParams]);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div>
          <h1 className="mb-1 text-lg font-semibold">新建连接</h1>
          <p className="text-xs text-slate-500">
            选择消息中间件，填写连接信息。连接成功后会自动出现在左侧列表。
          </p>
        </div>

        {saved.length > 0 ? (
          <SavedConnectionsCard
            entries={saved}
            onChange={setSaved}
            onUse={useSaved}
            onEdit={(entry) => {
              setKind(entry.config.kind);
              setName(entry.name);
            }}
          />
        ) : null}

        <Card>
          <CardHeader title="连接信息" />
          <CardBody className="flex flex-col gap-4">
            <div className="flex gap-2">
              {plugins?.map((plugin) => (
                <Button
                  key={plugin.kind}
                  variant={plugin.kind === kind ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => setKind(plugin.kind)}
                >
                  {BROKER_LABEL[plugin.kind]}
                </Button>
              ))}
            </div>

            <Field label="连接名称（可选）" hint="同名同类型会覆盖已保存的连接">
              <Input
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="例如：本地 Kafka"
              />
            </Field>

            {kind === "kafka" ? (
              <ConnectionFormKafka
                submitting={openConnection.isPending}
                onSubmit={submit}
                save={save}
                onSaveChange={setSave}
              />
            ) : (
              <ConnectionFormRabbitMq
                submitting={openConnection.isPending}
                onSubmit={submit}
                save={save}
                onSaveChange={setSave}
              />
            )}
          </CardBody>
        </Card>

        <div className="flex flex-wrap gap-1.5">
          {plugins?.flatMap((plugin) =>
            plugin.capabilities.map((capability) => (
              <Badge key={`${plugin.kind}-${capability}`} tone="neutral">
                {plugin.displayName} · {capability}
              </Badge>
            )),
          )}
        </div>
      </div>
    </div>
  );
}

function defaultName(config: ConnectionConfig): string {
  return config.kind === "kafka"
    ? `Kafka ${config.brokers[0] ?? ""}`.trim()
    : `RabbitMQ ${config.host}:${config.port}`;
}

/** 表单公共的提交区：保存开关 + 提交按钮。 */
export function SubmitRow({
  submitting,
  label,
  save,
  onSaveChange,
}: {
  submitting: boolean;
  label: string;
  save: boolean;
  onSaveChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="flex items-start gap-2 text-(length:--text-app-meta) text-slate-400">
        <input
          type="checkbox"
          className="mt-0.5 accent-sky-500"
          checked={save}
          onChange={(event) => onSaveChange(event.currentTarget.checked)}
        />
        <span>
          保存此连接（连同密码写入本机 localStorage）
          <br />
          <span className="text-slate-500">不勾选则仅在本次运行期间有效</span>
        </span>
      </label>
      <Button type="submit" loading={submitting}>
        {label}
      </Button>
    </div>
  );
}

/** 表单共用的默认值，集中在这里避免各表单各自硬编码。 */
export const FORM_DEFAULTS = {
  kafka: {
    brokers: "127.0.0.1:9092",
    mechanism: "none" as SaslMechanism,
    tls: "disabled" as TlsMode,
  },
  rabbitMq: {
    host: "127.0.0.1",
    port: 5672,
    tls: "disabled" as TlsMode,
    username: "guest",
    password: "guest",
    vhost: "/",
  },
};

/** 让 Select 的选项集中在同一处维护。 */
export const TLS_OPTIONS: { value: TlsMode; label: string }[] = [
  { value: "disabled", label: "不启用" },
  { value: "required", label: "强制 TLS" },
];

export const SASL_OPTIONS: { value: SaslMechanism; label: string }[] = [
  { value: "none", label: "无" },
  { value: "plain", label: "PLAIN" },
  { value: "scramSha256", label: "SCRAM-SHA-256" },
  { value: "scramSha512", label: "SCRAM-SHA-512" },
];
