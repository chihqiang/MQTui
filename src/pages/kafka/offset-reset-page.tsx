import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ComboInput,
  Empty,
  ErrorState,
  Field,
  Input,
  Modal,
  Select,
} from "@/components/ui";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { useConsumerGroups } from "@/hooks/use-consumer-groups";
import { useConnections } from "@/hooks/use-connections";
import { useCommitReset, useResetPhases, useResetPreview } from "@/hooks/use-offset-reset";
import { useTopics } from "@/hooks/use-broker-data";
import { dedupeChoices } from "@/lib/choice";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { formatNumber } from "@/lib/format";
import {
  canSubmit,
  changedCount,
  confirmToken,
  describeImpact,
  describeStep,
  planTone,
  stepTone,
} from "@/lib/offset-reset";
import { connectionMemoryKey, listRecentGroups, rememberGroup } from "@/lib/workspace-storage";
import { useSessionStore } from "@/stores";
import type { ResetPlan, ResetTarget } from "@/types";

const TARGETS: { value: ResetTarget; label: string; hint: string }[] = [
  { value: "earliest", label: "最早位点", hint: "重放主题保留的全部分区数据" },
  { value: "latest", label: "末尾位点", hint: "跳过当前全部积压" },
];

/**
 * 消费组位点重置页。
 *
 * 这一页的设计目标只有一个：**让用户在按下确认之前就看清后果**。
 * 所以顺序是「填条件 → 生成对照表 → 逐分区看 delta → 手打确认串 → 提交」，
 * 而不是「填条件 → 确认 → 成功」。
 *
 * 只开放「最早 / 末尾」两种目标。精确位点与按时间需要用户另外输入数字或时间戳，
 * 输入错一个零就从「重放一天」变成「重放一年」—— 那两个入口等真有需求再加，
 * 而且加的时候也应该是独立的、更重的确认流程。
 */
export function OffsetResetPage() {
  const { connectionId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: topics } = useTopics(connectionId, true);
  /**
   * 组名候选。这一页是全站唯一「敲错名字代价最大」的输入：组名打错，预览会说
   * 「没有需要改动的分区」，用户很容易读成「这个组没问题」，而真相是查了个不存在的组。
   * 一次拉 100 组（与列表页同页大小），超出部分照旧可以手输。
   */
  const { data: groupPage } = useConsumerGroups(connectionId, "");
  /**
   * 候选 = 「服务端第一页」+「这位用户最近用过的」。
   *
   * 只给第一页是不够的：几百个组的集群里，真正要重置的那个组通常在后面。
   * 最近用过的排前面 —— 它们正是「刚才在那个页面看过的那个组」。
   * 组名与连接记忆的 key 都要真实存在，所以顺手拿到当前连接的标识。
   */
  const { data: connections } = useConnections();
  const activeConnectionId = useSessionStore((state) => state.activeConnectionId);
  const connection = connections?.find((item) => item.id === activeConnectionId);
  const memoryKey = connection
    ? connectionMemoryKey(connection.kind, connection.endpoint)
    : "";
  const recentGroups = memoryKey ? listRecentGroups(memoryKey) : [];
  const groupChoices = useMemo(() => {
    const remote = (groupPage?.pages[0]?.items ?? []).map((item) => ({
      value: item.name,
      hint: item.members > 0 ? `${item.members} 成员` : "无成员",
    }));
    return dedupeChoices([
      ...recentGroups.map((name) => ({ value: name, hint: "最近用过" })),
      ...remote,
    ]);
  }, [groupPage, memoryKey]);
  /**
   * 组名可以由别的页面带过来（消费组详情里的「重置位点」）：
   * 那个组名是人刚刚在上一页看见的东西，不该让他记住再敲一遍。
   *
   * 组名从 URL 派生，用户自己敲的也写回 URL。
   *
   * 为什么不让它留在 `useState` 里：消费组详情页的「重置位点」是带着 `?group=`
   * 跳过来的，同一页里再点一次那条链接，本地 state 不会变 —— 而用户期待的正是
   * 「换成我刚点的那个组」。URL 是这一页唯一的输入来源，state 只能在它之上做草稿。
   */
  const group = searchParams.get("group") ?? "";
  const setGroup = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next.trim()) params.set("group", next);
        else params.delete("group");
        return params;
      },
      { replace: true },
    );
  };
  const [topic, setTopic] = useState("");
  const [target, setTarget] = useState<ResetTarget>("earliest");
  const [previewing, setPreviewing] = useState(false);

  // 生成对照表那一刻就把组名记下来：候选里出现「刚才那个组」比猜第一页准得多。
  // 不在每次按键时记 —— 打字过程中的半截名字不值得占用一格候选。
  useEffect(() => {
    if (!memoryKey || !previewing) return;
    rememberGroup(memoryKey, group);
  }, [memoryKey, previewing, group]);

  const ready = group.trim().length > 0 && topic.trim().length > 0;
  const preview = useResetPreview(connectionId, group.trim(), topic.trim(), target, previewing);
  const phases = useResetPhases(connectionId, group.trim() || undefined);

  // 换条件就丢掉旧计划：留着上一轮的对照表，用户很容易看成这一轮的结果。
  useEffect(() => setPreviewing(false), [group, topic, target]);

  // 带组名进来时，主题这一格是该页唯一还空着的填空 —— 把光标放过去。
  // 依赖是「这次要不要聚焦」这个布尔：`searchParams` 对象每次导航都换引用，
  // 直接依赖它会在同一页里反复抢焦点。`null` 读到 URL 之后就不会变了。
  const focusTopic = searchParams.get("group") !== null;
  useEffect(() => {
    if (!focusTopic) return;
    document.querySelector<HTMLSelectElement>('[data-offset-reset="topic"]')?.focus();
  }, [focusTopic]);

  return (
    <PageBody>
      <PageHeader
        title="位点重置"
        description="先生成逐分区对照表、看清「重放多少条」，手打组名之后才会真正执行"
      />

      <Card>
        <CardHeader title="条件" />
        <CardBody className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field
            label="消费组"
            hint={
              groupChoices.length
                ? "可从候选里点，也可以直接敲；候选＝最近用过的 + 集群里的前 100 个"
                : "集群里的组名没读到，直接敲组名即可"
            }
          >
            <ComboInput
              value={group}
              choices={groupChoices}
              placeholder="例如 orders-worker"
              onValueChange={setGroup}
            />
          </Field>
          <Field label="主题">
            <Select
              data-offset-reset="topic"
              value={topic}
              onChange={(event) => setTopic(event.currentTarget.value)}
            >
              <option value="">选择主题…</option>
              {(topics ?? []).map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="目标">
            <Select
              value={target}
              onChange={(event) => setTarget(event.currentTarget.value as ResetTarget)}
            >
              {TARGETS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label} — {item.hint}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          disabled={!ready || preview.isFetching}
          onClick={() => setPreviewing(true)}
        >
          {preview.isFetching ? "生成中…" : "生成对照表"}
        </Button>
        <span className="text-(length:--text-app-body) text-slate-500">
          预览是只读的，不会改动任何位点。
        </span>
      </div>

      {!ready ? (
        <Empty title="先填消费组与主题" description="位点重置必须明确到「哪个组的哪个主题」" />
      ) : null}

      {preview.error ? (
        <ErrorState
          message={failureText("生成位点对照表", errorMessage(preview.error))}
          onRetry={() => void preview.refetch()}
        />
      ) : null}

      {preview.data ? (
        <PlanCard
          connectionId={connectionId}
          group={group.trim()}
          topic={topic.trim()}
          plan={preview.data}
          phases={phases.data ?? []}
        />
      ) : null}
    </PageBody>
  );
}

function PlanCard({
  connectionId,
  group,
  topic,
  plan,
  phases,
}: {
  connectionId: string | undefined;
  group: string;
  topic: string;
  plan: ResetPlan;
  phases: { order: number; title: string; detail: string }[];
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <Card>
      <CardHeader
        title={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-(length:--text-app-title) text-slate-800">{plan.targetLabel}</span>
            <Badge tone={planTone(plan)}>{describeImpact(plan)}</Badge>
            <span className="text-(length:--text-app-meta) text-slate-500">
              分区 {plan.steps.length} 个 · 需要改动 {changedCount(plan)} 个
            </span>
          </div>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {plan.blockers.length > 0 ? (
          <div className="rounded border border-rose-200 bg-rose-50 p-3">
            <p className="text-(length:--text-app-body) text-rose-800">当前条件无法执行：</p>
            <ul className="mt-1 list-disc pl-5 text-(length:--text-app-body) text-rose-700">
              {plan.blockers.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {plan.notes.length > 0 ? (
          <ul className="list-disc pl-5 text-(length:--text-app-body) text-amber-700">
            {plan.notes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}

        <div className="max-h-80 overflow-auto rounded border border-slate-200">
          <table className="w-full text-left text-(length:--text-app-body)">
            <thead className="text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">
              <tr className="border-b border-slate-200">
                <th className="px-3 py-2 font-normal">分区</th>
                <th className="px-3 py-2 font-normal">当前位点</th>
                <th className="px-3 py-2 font-normal">目标位点</th>
                <th className="px-3 py-2 font-normal">影响</th>
              </tr>
            </thead>
            <tbody>
              {plan.steps.map((step) => (
                <tr key={step.partition} className="border-b border-slate-200 last:border-0">
                  <td className="px-3 py-2 font-mono text-slate-600">{step.partition}</td>
                  <td className="px-3 py-2 font-mono text-slate-500">
                    {step.from === null ? "未提交" : formatNumber(step.from)}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-600">{formatNumber(step.to)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={stepTone(step)}>{describeStep(step)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {phases.length > 0 ? (
          <ol className="flex flex-col gap-1.5 text-(length:--text-app-body) text-slate-500">
            {phases.map((phase) => (
              <li key={phase.order}>
                <span className="text-slate-600">
                  {phase.order}. {phase.title}
                </span>
                {" — "}
                {phase.detail}
              </li>
            ))}
          </ol>
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="danger"
            disabled={plan.blockers.length > 0 || changedCount(plan) === 0}
            onClick={() => setConfirming(true)}
          >
            提交新位点
          </Button>
        </div>
      </CardBody>

      <CommitModal
        connectionId={connectionId}
        group={group}
        topic={topic}
        plan={plan}
        open={confirming}
        onClose={() => setConfirming(false)}
      />
    </Card>
  );
}

/**
 * 提交确认框。
 *
 * 要求手打 `reset <消费组名>`：这一步不是为了防误点，而是为了让用户在
 * 提交前再念一遍消费组的名字 —— 打错组名是这类操作最常见的真实事故。
 */
function CommitModal({
  connectionId,
  group,
  topic,
  plan,
  open,
  onClose,
}: {
  connectionId: string | undefined;
  group: string;
  topic: string;
  plan: ResetPlan;
  open: boolean;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const commit = useCommitReset(connectionId);
  const pushToast = useSessionStore((state) => state.pushToast);

  useEffect(() => {
    if (open) setInput("");
  }, [open]);

  const submit = () => {
    commit.mutate(
      { group, topic, plan },
      {
        onSuccess: (outcome) => {
          pushToast(
            "success",
            `已提交 ${outcome.committed} 个分区；重放 ${outcome.replay} 条，跳过 ${outcome.skip} 条`,
          );
          onClose();
        },
        onError: (error) => pushToast("error", errorMessage(error)),
      },
    );
  };

  return (
    <Modal
      open={open}
      title="提交位点重置"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={!canSubmit(plan, input, group) || commit.isPending}
            onClick={submit}
          >
            {commit.isPending ? "提交中…" : "确认提交"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-(length:--text-app-body) text-slate-600">
        <p>
          消费组 <span className="font-mono text-slate-900">{group}</span> · 主题{" "}
          <span className="font-mono text-slate-900">{topic}</span>
        </p>
        <p className="text-amber-700">{describeImpact(plan)}</p>
        <p className="text-slate-500">
          请确认该消费组已经没有活跃成员。若消费者仍在运行，它们的下一次自动提交会把位点改回去，
          这次操作就白做了。
        </p>
        <Field label={`输入 ${confirmToken(group)} 以确认`}>
          <Input
            value={input}
            placeholder={confirmToken(group)}
            onChange={(event) => setInput(event.currentTarget.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
