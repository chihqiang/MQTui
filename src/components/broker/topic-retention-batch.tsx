import { useState } from "react";

import { Button, Field, Input, Modal, Segmented } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import {
  RETENTION_PRESETS,
  describeRetention,
  describeRetentionPlan,
  retentionChanges,
  retentionIssue,
  summarizeRetention,
  type RetentionInput,
} from "@/lib/retention";
import { describePlan, submitChanges } from "@/lib/topic-config";
import { topicService } from "@/services";
import { useSessionStore } from "@/stores";
import { ConfigConfirmModal } from "./topic-config-confirm";
import type { ConfigPreview } from "@/types";

/**
 * 批量设置保留时长。
 *
 * 从「主题列表勾一批 → 设保留」直接打开，不必逐个跳进配置项编辑器。
 * 保留时长是这张表上唯一每个主题都常用、又常常要一起改的项，所以值得这条近路；
 * 别的配置项仍然走详情页 —— 把「批量改 cleanup.policy」做得太顺手不是好事。
 *
 * 流程与单个主题没有两样：**选择 → 逐个预览 → 逐份确认 → 逐个提交**。
 * 预览走的是后端同一个接口，所以「改前 → 改后」与后果说明不会有两套说法。
 */
export function TopicRetentionBatchModal({
  connectionId,
  topics,
  internal,
  onClose,
}: {
  connectionId: string | undefined;
  topics: string[];
  /** 内部主题由 Kafka 独占管理，直接跳过，不提交。 */
  internal: string[];
  onClose: () => void;
}) {
  const targets = topics.filter((name) => !internal.includes(name));
  const [preset, setPreset] = useState(String(RETENTION_PRESETS[3].ms));
  const [custom, setCustom] = useState("");
  const [plans, setPlans] = useState<{ topic: string; preview: ConfigPreview }[]>([]);
  const [failures, setFailures] = useState<{ topic: string; detail: string }[]>([]);
  const [stage, setStage] = useState<"edit" | "review" | "confirm">("edit");
  // 逐份确认的进度提到这里：确认框是「一串」里的第几份，属于这个弹窗的状态。
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const pushToast = useSessionStore((state) => state.pushToast);

  const input: RetentionInput = {
    action: { kind: "set", ms: Number.parseInt(preset, 10) },
    custom,
  };
  const issue = retentionIssue(input);
  // 本地渲染时的对照行：真正的「改了哪几项」仍以每份预览里的计划为准。
  const changes = retentionChanges(targets, input);

  /**
   * 逐个预览。
   *
   * 顺序循环而不是 `Promise.all`：几十个请求一起打到 broker 上，报错会互相淹没，
   * 而这类管理接口本就没为并发设计。慢一点，但每一行的成败都能对上号。
   */
  const review = async () => {
    if (issue || !targets.length) return;
    setRunning(true);
    setStage("review");
    const ok: { topic: string; preview: ConfigPreview }[] = [];
    const bad: { topic: string; detail: string }[] = [];
    for (const topic of targets) {
      try {
        ok.push({
          topic,
          preview: await topicService.previewConfigs(connectionId as string, topic, changes),
        });
      } catch (error) {
        bad.push({ topic, detail: errorMessage(error) });
      }
    }
    setPlans(ok);
    setFailures(bad);
    setRunning(false);
    // 核对完直接进确认：再让用户点一次「去确认」是多余的中间步骤。
    if (ok.length) setStage("confirm");
  };

  /** 逐个提交，逐个记结果 —— 批量最怕的是一句「完成」。 */
  const submit = async () => {
    setRunning(true);
    const results: { topic: string; ok: boolean; detail: string }[] = [];
    for (const item of plans) {
      const next = submitChanges(item.preview?.plan);
      try {
        const outcome = await topicService.updateConfigs(
          connectionId as string,
          item.topic,
          next,
        );
        results.push({ topic: item.topic, ok: true, detail: outcome.detail });
      } catch (error) {
        results.push({ topic: item.topic, ok: false, detail: errorMessage(error) });
      }
    }
    setRunning(false);
    const summary = summarizeRetention(results);
    pushToast(summary.failed ? "error" : "success", summary.text);
    onClose();
  };

  return (
    <>
      <Modal
        open={stage !== "confirm"}
        title={`批量设置保留时长 · ${targets.length} 个主题`}
        onClose={onClose}
        footer={
          stage === "edit" ? (
            <>
              <Button size="sm" variant="ghost" onClick={onClose}>
                取消
              </Button>
              <Button size="sm" disabled={Boolean(issue) || running} onClick={() => void review()}>
                {running ? "核对中…" : "核对影响"}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={running} onClick={() => setStage("edit")}>
                返回修改
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={running || !plans.length}
                onClick={() => {
                  setConfirmIndex(0);
                  setStage("confirm");
                }}
              >
                {`逐份确认（${plans.length}）`}
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-3 text-(length:--text-app-body) text-slate-600">
          {stage === "edit" ? (
            <>
              <Field label="保留时长" hint="按消息写入时间算；到期的日志段整段删除，不可找回">
                <Segmented
                  options={RETENTION_PRESETS.map((item) => ({
                    value: String(item.ms),
                    label: item.label,
                    title: item.hint || describeRetention(item.ms),
                  }))}
                  value={preset}
                  onChange={(next) => {
                    setPreset(next);
                    setCustom("");
                  }}
                />
              </Field>
              <Field label="或手填毫秒数" hint={issue ?? undefined}>
                <Input
                  value={custom}
                  placeholder="留空则用上面选中的档位"
                  inputMode="numeric"
                  onChange={(event) => setCustom(event.currentTarget.value)}
                />
              </Field>
              {internal.length ? (
                <p className="text-(length:--text-app-meta) text-amber-700">
                  内部主题不参与批量修改，会被跳过：{internal.join("、")}
                </p>
              ) : null}
              <p className="text-(length:--text-app-meta) text-slate-500">
                下一步会逐个主题向后端要一份「改前 → 改后」与后果说明，核对完才会真正提交。
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <p>{running ? "正在逐个核对…" : `${plans.length} 个主题通过了核对`}</p>
              <ul className="flex max-h-64 flex-col gap-1 overflow-auto font-mono text-(length:--text-app-meta)">
                {plans.map((item) => (
                  <li key={item.topic} className="flex gap-2">
                    <span className="shrink-0 text-slate-800">{item.topic}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-500">
                      {/* 与确认框同一套说法：用 `describePlan` 而不是在这里另拼一遍。 */}
                      {describePlan(item.preview.plan).join(" · ") || "无改动"}
                    </span>
                  </li>
                ))}
              </ul>
              {failures.length ? (
                <div className="rounded border border-rose-200 bg-rose-50 p-2">
                  <p className="text-rose-800">这些主题没通过核对，不会提交：</p>
                  <ul className="mt-1 list-disc pl-5 text-(length:--text-app-meta) text-rose-700">
                    {failures.map((item) => (
                      <li key={item.topic}>
                        <span className="font-mono">{item.topic}</span> — {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {describeRetentionPlan({
                targets: plans.map((item) => item.topic),
                input,
                skipped: internal,
              }).map((line) => (
                <p key={line} className="text-(length:--text-app-meta) text-amber-700">
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* 逐份确认：和后端给的计划逐条对照，而不是只报一个总数。 */}
      <BatchConfirmQueue
        open={stage === "confirm"}
        plans={plans}
        index={confirmIndex}
        pending={running}
        onCancel={() => setStage("review")}
        onNext={() => setConfirmIndex((current) => current + 1)}
        onConfirm={() => void submit()}
      />
    </>
  );
}

/**
 * 逐份确认的容器。
 *
 * 复用详情页那个确认框（同一份「改动 / 后果 / 版本兼容」的呈现），
 * 只是把它变成一串：确认一份，下一份；最后一份确认完才提交。
 * 想取消随时可以退回去改时长 —— 这一步之前什么都没写。
 */
function BatchConfirmQueue({
  open,
  plans,
  index,
  pending,
  onCancel,
  onNext,
  onConfirm,
}: {
  open: boolean;
  plans: { topic: string; preview: ConfigPreview }[];
  index: number;
  pending: boolean;
  onCancel: () => void;
  onNext: () => void;
  onConfirm: () => void;
}) {
  if (!open || !plans.length) return null;
  const current = plans[Math.min(index, plans.length - 1)];
  const last = index >= plans.length - 1;

  return (
    <ConfigConfirmModal
      plan={current.preview.plan}
      compat={current.preview.compat}
      title={`确认修改配置 · ${current.topic}${plans.length > 1 ? `（${index + 1}/${plans.length}）` : ""}`}
      note="批量任务是逐个主题提交的：确认后按顺序写下去，中途失败会点名是哪一个，已经改好的不回滚。"
      pending={pending}
      onClose={onCancel}
      onConfirm={() => (last ? onConfirm() : onNext())}
    />
  );
}
