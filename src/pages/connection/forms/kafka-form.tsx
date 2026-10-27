import { useEffect, useState } from "react";

import { Field, Input, Select } from "@/components/ui";
import { readDraft, writeDraft } from "@/lib/session-storage";
import type { ConnectionConfig, SaslMechanism, TlsMode } from "@/types";

import { FORM_DEFAULTS, SASL_OPTIONS, SubmitRow, TLS_OPTIONS } from "../connect-page";

interface Props {
  submitting: boolean;
  onSubmit: (config: ConnectionConfig) => void;
  save: boolean;
  onSaveChange: (next: boolean) => void;
  /**
   * 要预填的配置（来自「连接记录」的「填入表单」）。
   *
   * 以前这里直接从草稿初始化一次，于是那条按钮点了只会切页签 —— 表单还是上一次的草稿。
   * 外部配置每次变化都整体覆盖一次：用户此刻的意图是「把这条记录摊开给我改」。
   */
  initialConfig?: Extract<ConnectionConfig, { kind: "kafka" }> | null;
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
export function ConnectionFormKafka({
  submitting,
  onSubmit,
  save,
  onSaveChange,
  initialConfig,
}: Props) {
  const [config, setConfig] = useState(() => initialConfig ?? initial());
  // 输入框里是原始字符串（允许中途敲出 `a,,b`），提交时才拆开 —— 所以单独存一份，
  // 初值必须和 config 同源，否则草稿里的多地址会被渲染成默认值。
  const [brokers, setBrokers] = useState(() => (initialConfig ?? initial()).brokers.join(","));

  useEffect(() => {
    if (!initialConfig) return;
    setConfig(initialConfig);
    setBrokers(initialConfig.brokers.join(","));
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
