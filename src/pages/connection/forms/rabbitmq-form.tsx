import { useEffect, useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { readDraft, writeDraft } from "@/lib/session-storage";
import type { ConnectionConfig, TlsMode } from "@/types";

import { FORM_DEFAULTS, SubmitRow, TLS_OPTIONS } from "../connect-page";

interface Props {
  submitting: boolean;
  onSubmit: (config: ConnectionConfig) => void;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  /** 要预填的配置（来自「连接记录」的「填入表单」），见 Kafka 表单里的同类说明。 */
  initialConfig?: Extract<ConnectionConfig, { kind: "rabbitMq" }> | null;
}

function initial(): ConnectionConfig & { kind: "rabbitMq" } {
  const draft = readDraft("rabbitMq");
  return (
    draft ?? {
      kind: "rabbitMq",
      host: FORM_DEFAULTS.rabbitMq.host,
      port: FORM_DEFAULTS.rabbitMq.port,
      tls: FORM_DEFAULTS.rabbitMq.tls,
      auth: {
        username: FORM_DEFAULTS.rabbitMq.username,
        password: FORM_DEFAULTS.rabbitMq.password,
        vhost: FORM_DEFAULTS.rabbitMq.vhost,
      },
      managementUrl: undefined,
    }
  );
}

/** RabbitMQ 连接表单。字段变更即时写入 localStorage 草稿。 */
export function ConnectionFormRabbitMq({
  submitting,
  onSubmit,
  save,
  onSaveChange,
  initialConfig,
}: Props) {
  const [config, setConfig] = useState(() => initialConfig ?? initial());

  useEffect(() => {
    if (!initialConfig) return;
    setConfig(initialConfig);
    writeDraft(initialConfig);
  }, [initialConfig]);

  const patch = (next: Partial<typeof config>) => {
    const merged = { ...config, ...next };
    setConfig(merged);
    writeDraft(merged);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(config);
      }}
    >
      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <Field label="Host">
          <Input
            value={config.host}
            onChange={(event) => patch({ host: event.currentTarget.value })}
            required
          />
        </Field>
        <Field label="Port">
          <Input
            type="number"
            value={String(config.port)}
            onChange={(event) => patch({ port: Number(event.currentTarget.value) })}
            required
          />
        </Field>
      </div>

      <Field label="TLS">
        <Select
          value={config.tls}
          onChange={(event) => patch({ tls: event.currentTarget.value as TlsMode })}
        >
          {TLS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="用户名">
          <Input
            value={config.auth.username}
            onChange={(event) =>
              patch({ auth: { ...config.auth, username: event.currentTarget.value } })
            }
          />
        </Field>
        <Field label="密码">
          <Input
            type="password"
            value={config.auth.password}
            onChange={(event) =>
              patch({ auth: { ...config.auth, password: event.currentTarget.value } })
            }
          />
        </Field>
      </div>

      <Field label="Virtual Host">
        <Input
          value={config.auth.vhost}
          onChange={(event) => patch({ auth: { ...config.auth, vhost: event.currentTarget.value } })}
        />
      </Field>

      <Field label="管理 API 地址（可选）">
        <Input
          value={config.managementUrl ?? ""}
          onChange={(event) =>
            patch({ managementUrl: event.currentTarget.value.trim() || undefined })
          }
          placeholder="http://localhost:15672"
        />
      </Field>
      <p className="text-(length:--text-app-meta) text-slate-500">
        队列列表与堆积量只能由管理插件提供；留空则需手动输入队列名查看消息。
      </p>

      <SubmitRow submitting={submitting} label="连接" save={save} onSaveChange={onSaveChange} />
    </form>
  );
}
