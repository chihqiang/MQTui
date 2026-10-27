import { useMemo, useState } from "react";

import { Badge, Button, Input, Select } from "@/components/ui";
import { usePreviewTopicConfigs, useUpdateTopicConfigs } from "@/hooks/use-topics";
import {
  collectChanges,
  hasChanges,
  missingConfigs,
  rowState,
  type ConfigRow,
} from "@/lib/topic-config";
import type { ConfigPreview, TopicDetail } from "@/types";
import { ConfigConfirmModal } from "@/pages/kafka/topic-config-confirm";

/**
 * 主题配置项编辑器。
 *
 * 这一页的设计出发点只有一个：**改配置有副作用，而且多半不可回退**。
 * `retention.ms` 调小，历史消息当场被清；`cleanup.policy` 换成 compact，
 * 整段日志的存储方式换个花样。所以流程被刻意拆成两段：
 *
 * 1. 输入阶段：只改本地草稿，不请求，不生效；
 * 2. 保存阶段：先向后端要一份「计划」（改什么、后果是什么），确认后才提交。
 *
 * 校验规则不在前端重写一份。前端只管「这一行能不能编辑」，值合不合法
 * 由后端 `plan_config_changes` 说 —— 两边各写一套，早晚会漂移成
 * 「预览说能改，提交被拒」。
 */
export function TopicConfigEditor({
  detail,
  connectionId,
}: {
  detail: TopicDetail;
  connectionId: string | undefined;
}) {
  const configs = detail.configs ?? [];
  const [rows, setRows] = useState<ConfigRow[]>(() =>
    configs.map((item) => ({ key: item.key, value: item.value, draft: item.value })),
  );
  const [previewResult, setPreviewResult] = useState<ConfigPreview | null>(null);
  const plan = previewResult?.plan ?? null;
  const compat = previewResult?.compat ?? null;
  const [adding, setAdding] = useState("");

  const preview = usePreviewTopicConfigs(connectionId, detail.name);
  const update = useUpdateTopicConfigs(connectionId, detail.name);

  // 详情刷新后（例如提交成功）用新值重置草稿，避免草稿停留在旧状态。
  const signature = useMemo(
    () => configs.map((item) => `${item.key}=${item.value}`).join("|"),
    [configs],
  );
  const [syncedSignature, setSyncedSignature] = useState(signature);
  if (signature !== syncedSignature) {
    setSyncedSignature(signature);
    setRows(configs.map((item) => ({ key: item.key, value: item.value, draft: item.value })));
  }

  const dirty = hasChanges(rows);
  const editable = rows.filter((row) => rowState(row, detail.internal).lock === "editable");

  const setDraft = (key: string, draft: string) =>
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, draft } : row)),
    );

  // 撤销 = 回到详情页上的值，并丢掉还没提交的新增行。
  const reset = () => {
    setAdding("");
    setRows(configs.map((item) => ({ key: item.key, value: item.value, draft: item.value })));
  };

  /**
   * 追加一个还没配置过的项。
   *
   * 主题详情只返回「被改过」的项，所以 `retention.ms` 在没配过时压根不在表里。
   * 没有这个入口，用户想给一个干净主题配上保留时长就无从下手——只能去敲命令行，
   * 而面板的价值正好在这里。
   *
   * 新增行的 `value` 记为空串：它代表的「当前状态」就是没有覆盖项。
   * 这样只要用户不填，`draft === value` 成立，不会被误判成一次改动。
   */
  const add = (key: string) => {
    if (!key) return;
    setAdding("");
    setRows((current) =>
      current.some((row) => row.key === key)
        ? current
        : [...current, { key, value: "", draft: "" }],
    );
  };

  const save = () => {
    const changes = collectChanges(rows);
    if (changes.length === 0) return;
    preview.mutate(changes, { onSuccess: (next) => setPreviewResult(next) });
  };

  const confirm = () => {
    if (!plan) return;
    const changes = plan.items.map((item) => ({ key: item.key, value: item.value }));
    update.mutate(changes, { onSuccess: () => setPreviewResult(null) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-(length:--text-app-meta) text-slate-500">
          {detail.internal
            ? "内部主题的配置由 Kafka 独占管理"
            : `${editable.length} 项可编辑 · 只展示被改过的项，默认值不列出`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {detail.internal ? null : (
            <AddSelect
              options={missingConfigs(rows)}
              value={adding}
              onSelect={(key) => {
                setAdding(key);
                add(key);
              }}
            />
          )}
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={reset}>
            撤销改动
          </Button>
          <Button size="sm" loading={preview.isPending} disabled={!dirty} onClick={save}>
            {preview.isPending ? "核对中…" : "保存"}
          </Button>
        </div>
      </div>

      {rows.length ? (
        <table className="w-full text-left text-(length:--text-app-title)">
          <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-normal">配置项</th>
              <th className="px-4 py-2 font-normal">值</th>
              <th className="px-4 py-2 font-normal">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ConfigRowView
                key={row.key}
                row={row}
                internal={detail.internal}
                onChange={setDraft}
              />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">
          {detail.internal ? "内部主题的配置由 Kafka 管理，不在此展示" : "没有改动过的配置项"}
        </p>
      )}

      <ConfigConfirmModal
        plan={plan}
        compat={compat}
        title={`确认修改配置 · ${detail.name}`}
        pending={update.isPending}
        onClose={() => setPreviewResult(null)}
        onConfirm={confirm}
      />
    </div>
  );
}

/**
 * 「添加配置项」下拉。
 *
 * 用 Select 而不是搜索框：候选项就十来个，且都是固定名字。让人手打
 * `message.timestamp.difference.max.ms` 这种事没人会心存感激。
 */
function AddSelect({
  options,
  value,
  onSelect,
}: {
  options: { key: string; label: string }[];
  value: string;
  onSelect: (key: string) => void;
}) {
  if (options.length === 0) {
    return <span className="text-(length:--text-app-meta) text-meta">可配置项都已列出</span>;
  }

  return (
    <Select
      className="w-44 text-(length:--text-app-body)"
      value={value}
      onChange={(event) => onSelect(event.currentTarget.value)}
    >
      <option value="">+ 添加配置项</option>
      {options.map((item) => (
        <option key={item.key} value={item.key}>
          {item.label}（{item.key}）
        </option>
      ))}
    </Select>
  );
}

function ConfigRowView({
  row,
  internal,
  onChange,
}: {
  row: ConfigRow;
  internal: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const state = rowState(row, internal);

  return (
    <tr className="border-b border-slate-200 last:border-0">
      <td className="w-2/5 px-4 py-2 font-mono text-(length:--text-app-body) text-slate-600">{row.key}</td>
      <td className="px-4 py-2">
        {state.lock === "editable" ? (
          <Input
            className="font-mono text-(length:--text-app-body)"
            value={row.draft}
            placeholder="留空表示恢复默认值"
            onChange={(event) => onChange(row.key, event.currentTarget.value)}
          />
        ) : (
          <span className="font-mono text-(length:--text-app-body) text-slate-500">{row.value}</span>
        )}
      </td>
      <td className="px-4 py-2">
        <ConfigRowBadge lock={state.lock} dirty={state.dirty} reason={state.reason} />
      </td>
    </tr>
  );
}

function ConfigRowBadge({
  lock,
  dirty,
  reason,
}: {
  lock: ReturnType<typeof rowState>["lock"];
  dirty: boolean;
  reason?: string;
}) {
  if (lock !== "editable") {
    return (
      <span title={reason}>
        <Badge tone="warning">不可修改</Badge>
      </span>
    );
  }
  if (dirty) return <Badge tone="info">待保存</Badge>;
  return <span className="text-(length:--text-app-body) text-slate-500">已生效</span>;
}
