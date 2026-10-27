import { useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { readDraft, writeDraft } from "@/lib/session-storage";
import type { ConnectionConfig, SaslMechanism, TlsMode } from "@/types";

import { FORM_DEFAULTS, SASL_OPTIONS, SubmitRow, TLS_OPTIONS } from "../connect-page";

interface Props {
  submitting: boolean;
  onSubmit: (config: ConnectionConfig) => void;
  save: boolean;
  onSaveChange: (next: boolean) => void;
}

/** 读取上次的草稿作为初值，没有则用默认值。 */
function initial(): ConnectionConfig & { kind: "kafka" } {
  const draft = readDraft("kafka");
  return (
    draft ?? {
      kind: "kafka",
      brokers: [FORM_DEFAULTS.kafka.brokers],
      tls: FORM_DEFAULTS.kafka.tls,
      auth: { mechanism: FORM_DEFAULTS.kafka.mechanism, username: "", password: "" },
      options: {},
    }
  );
}

/** Kafka 连接表单。字段变更即时写入 localStorage 草稿，误关页面不丢输入。 */
export function ConnectionFormKafka({ submitting, onSubmit, save, onSaveChange }: Props) {
  const [config, setConfig] = useState(initial);
  const [brokers, setBrokers] = useState(config.brokers.join(","));

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
        onSubmit({
          ...config,
          brokers: brokers
            .split(/[\s,]+/)
            .map((item) => item.trim())
            .filter(Boolean),
        });
      }}
    >
      <Field label="Bootstrap Servers" hint="多个地址用逗号或空格分隔">
        <Input
          value={brokers}
          onChange={(event) => setBrokers(event.currentTarget.value)}
          placeholder="127.0.0.1:9092"
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
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

        <Field label="SASL 机制">
          <Select
            value={config.auth.mechanism}
            onChange={(event) =>
              patch({
                auth: { ...config.auth, mechanism: event.currentTarget.value as SaslMechanism },
              })
            }
          >
            {SASL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {config.auth.mechanism !== "none" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="用户名">
            <Input
              value={config.auth.username}
              onChange={(event) => patch({ auth: { ...config.auth, username: event.currentTarget.value } })}
            />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              value={config.auth.password}
              onChange={(event) => patch({ auth: { ...config.auth, password: event.currentTarget.value } })}
            />
          </Field>
        </div>
      ) : null}

      <SubmitRow
        submitting={submitting}
        label="连接"
        save={save}
        onSaveChange={onSaveChange}
      />
    </form>
  );
}
