import { useEffect, useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { defaultConnection } from "@/lib/connection-defaults";
import { followManagementUrl, managementUrlFor, withManagementUrl } from "@/lib/management-url";
import { readDraft, writeDraft } from "@/lib/session-storage";
import { TLS_OPTIONS, type ConnectionConfig, type TlsMode } from "@/types";

import { SubmitRow } from "@/components/broker/submit-row";

interface Props {
  /** 表单的 DOM id，见 Kafka 表单里的同类说明。 */
  formId: string;
  onSubmit: (config: ConnectionConfig) => void;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  /** 要预填的配置（来自「连接记录」的「填入表单」），见 Kafka 表单里的同类说明。 */
  initialConfig?: Extract<ConnectionConfig, { kind: "rabbitMq" }> | null;
}

/**
 * 表单初值。管理地址没填过就先填上按 Host 推出来的那个 ——
 * 打开表单第一眼就能看见它，改与不改都行，但「原来还有这么一格」这件事不必靠说明文字。
 */
function initial(): ConnectionConfig & { kind: "rabbitMq" } {
  const draft = readDraft("rabbitMq");
  const base = draft?.kind === "rabbitMq" ? draft : defaultConnection("rabbitMq");
  return base.managementUrl === undefined
    ? { ...base, managementUrl: managementUrlFor(base.host, base.tls !== "disabled") }
    : base;
}

/** RabbitMQ 连接表单。字段变更即时写入 localStorage 草稿。 */
export function ConnectionFormRabbitMq({
  formId,
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

  /**
   * 改 Host / TLS：管理地址跟着走，但只跟到「还是自动填的那个」为止。
   * 手填过就不动，见 `lib/management-url.ts` 里的说明。
   */
  const patchEndpoint = (next: { host?: string; tls?: TlsMode }) => {
    const host = next.host ?? config.host;
    const tls = next.tls ?? config.tls;
    patch({
      host,
      tls,
      managementUrl: followManagementUrl(
        config.managementUrl,
        config.host,
        config.tls !== "disabled",
        host,
        tls !== "disabled",
      ),
    });
  };

  return (
    <form
      id={formId}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        // 空着的那一格在这一刻补齐：之后所有能力都按地址走，界面也该照着它显示。
        onSubmit(withManagementUrl(config, managementUrlFor(config.host, config.tls !== "disabled")));
      }}
    >
      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <Field label="Host">
          <Input
            value={config.host}
            onChange={(event) => patchEndpoint({ host: event.currentTarget.value })}
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
          onChange={(event) => patchEndpoint({ tls: event.currentTarget.value as TlsMode })}
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

      <Field label="管理 API 地址">
        <Input
          value={config.managementUrl ?? ""}
          onChange={(event) => patch({ managementUrl: event.currentTarget.value.trim() })}
          placeholder={managementUrlFor(config.host, config.tls !== "disabled")}
        />
      </Field>
      <p className="text-(length:--text-app-meta) text-slate-500">
        队列、交换机、绑定、策略、参数、消费者都走这个地址（管理插件，默认 15672）。
        按上面的 Host 自动填，可以改；清空后下次改 Host 会重新跟着走。
      </p>

      <SubmitRow save={save} onSaveChange={onSaveChange} />
    </form>
  );
}
