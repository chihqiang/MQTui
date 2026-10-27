import { useMemo, useState } from "react";

import { Badge, Button, Input, Modal, Select } from "@/components/ui";
import { usePreviewTopicConfigs, useUpdateTopicConfigs } from "@/hooks/use-topics";
import {
  collectChanges,
  describePlan,
  hasChanges,
  isRisky,
  missingConfigs,
  rowState,
  type ConfigRow,
} from "@/lib/topic-config";
import type { ConfigCompatReport, ConfigPlan, ConfigPreview, TopicDetail } from "@/types";

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
        <table className="w-full text-left text-sm">
          <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-slate-500">
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
        <p className="px-4 py-3 text-xs text-slate-500">
          {detail.internal ? "内部主题的配置由 Kafka 管理，不在此展示" : "没有改动过的配置项"}
        </p>
      )}

      <ConfirmModal
        plan={plan}
        compat={compat}
        topic={detail.name}
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
      className="w-44 text-xs"
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
      <td className="w-2/5 px-4 py-2 font-mono text-xs text-slate-600">{row.key}</td>
      <td className="px-4 py-2">
        {state.lock === "editable" ? (
          <Input
            className="font-mono text-xs"
            value={row.draft}
            placeholder="留空表示恢复默认值"
            onChange={(event) => onChange(row.key, event.currentTarget.value)}
          />
        ) : (
          <span className="font-mono text-xs text-slate-500">{row.value}</span>
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
  return <span className="text-xs text-slate-500">已生效</span>;
}

/**
 * 提交前的确认框。
 *
 * 三个必须出现的内容：改的是哪几项（改前 → 改后）、后果是什么、
 * 值清空等于恢复默认。少任何一条，用户都没法判断自己是不是填错了一格。
 */
function ConfirmModal({
  plan,
  compat,
  topic,
  pending,
  onClose,
  onConfirm,
}: {
  plan: ConfigPlan | null;
  compat: ConfigCompatReport | null;
  topic: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const open = plan !== null;
  const lines = plan ? describePlan(plan) : [];
  const impacts = plan?.impacts ?? [];
  const resets = plan?.items.filter((item) => item.value.trim() === "") ?? [];

  return (
    <Modal
      open={open}
      title={`确认修改配置 · ${topic}`}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={pending || !plan?.items.length || compat?.ok === false}
            onClick={onConfirm}
          >
            {pending ? "提交中…" : compat?.ok === false ? "版本不支持" : "确认修改"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs text-slate-600">
        {plan && plan.items.length === 0 ? (
          <p className="text-slate-500">配置没有变化，无需提交。</p>
        ) : null}

        {lines.length ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-slate-500">改动</p>
            <ul className="flex flex-col gap-1 font-mono text-(length:--text-app-meta) text-slate-800">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {resets.length ? (
          <p className="text-amber-700">
            清空值的项将删除覆盖项，回落到 broker 默认值：
            {resets.map((item) => item.key).join(", ")}
          </p>
        ) : null}

        {isRisky(plan as ConfigPlan) ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
            <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-amber-400/80">
              提交前请确认后果
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {impacts.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {compat ? <CompatBlock report={compat} /> : null}

        <p className="text-slate-500">
          提交走增量接口，未列出的配置项保持原样。改动会立即对新写入的数据生效。
        </p>
      </div>
    </Modal>
  );
}

/**
 * 版本兼容性区块。
 *
 * 三档分开显示，而不是只标一个红点：
 * - `unsupported`（红）：确定集群版本不够，提交必被拒，按钮直接锁住；
 * - `unknown`（灰）：读不到集群版本。**不锁按钮** —— 探测不到不等于不支持，
 *   因为探测失败把功能整个关掉，比让用户点一下再被拒更糟；
 * - `supported`：只在有额外注意事项时才列出，否则一行「全部满足」就够。
 */
function CompatBlock({ report }: { report: ConfigCompatReport }) {
  const blocked = report.items.filter((item) => item.verdict === "unsupported");
  const unknown = report.items.filter((item) => item.verdict === "unknown");
  const supported = report.items.filter((item) => item.verdict === "supported");

  if (!report.items.length) return null;

  const version = report.clusterVersion ?? "未知";

  return (
    <div className="flex flex-col gap-2">
      {blocked.length ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-800">
          <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-rose-400/80">
            集群版本不支持（当前 {version}）
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {blocked.map((item) => (
              <li key={item.name}>
                <span className="font-mono text-(length:--text-app-meta)">{item.name}</span> — {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unknown.length ? (
        <p className="text-slate-500">
          读不到集群版本，以下 {unknown.length} 项未做兼容性校验（提交时若被服务端拒绝，
          原因通常是这一项在集群上不存在）：
          {unknown.map((item) => item.name).join(", ")}
        </p>
      ) : null}

      {!blocked.length && !unknown.length ? (
        <p className="text-slate-500">
          版本检查通过：{supported.length} 项在当前集群（{version}）上可用。
        </p>
      ) : null}
    </div>
  );
}
