import { Button, Modal } from "@/components/ui";
import { describePlan, isRisky, planImpacts, planItems } from "@/lib/topic-config";
import type { ConfigCompatReport, ConfigPlan } from "@/types";

/**
 * 提交前的确认框。
 *
 * 三个必须出现的内容：改的是哪几项（改前 → 改后）、后果是什么、
 * 值清空等于恢复默认。少任何一条，用户都没法判断自己是不是填错了一格。
 */
export function ConfigConfirmModal({
  plan,
  compat,
  title,
  note,
  pending,
  onClose,
  onConfirm,
}: {
  plan: ConfigPlan | null;
  compat: ConfigCompatReport | null;
  /** 弹窗标题，通常带上改的是哪个主题（批量时说明这一份是哪个主题的）。 */
  title: string;
  /** 底部那句收尾说明；默认是单个主题编辑器里的措辞。 */
  note?: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const open = plan !== null;
  // `plan` 可能来自缓存或另一版后端：字段缺失时按「没有」处理，不能直接取值。
  const items = planItems(plan);
  const lines = describePlan(plan);
  const impacts = planImpacts(plan);
  // `value` 也可能缺：非空判断要容得下 undefined，不能让一行数据把整页带下去。
  const resets = items.filter((item) => (item.value ?? "").trim() === "");

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={pending || !items.length || compat?.ok === false}
            onClick={onConfirm}
          >
            {pending ? "提交中…" : compat?.ok === false ? "版本不支持" : "确认修改"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-(length:--text-app-body) text-slate-600">
        {plan && !items.length ? (
          <p className="text-slate-500">配置没有变化，无需提交。</p>
        ) : null}

        {lines.length ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-secondary font-medium">改动</p>
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

        {isRisky(plan) && impacts.length ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
            <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-amber-700">
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
          {note ?? "提交走增量接口，未列出的配置项保持原样。改动会立即对新写入的数据生效。"}
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
export function CompatBlock({ report }: { report: ConfigCompatReport }) {
  // 体检项同样可能缺席（后端不下发空数组），与计划一样按「没有」兜底。
  const items = report.items ?? [];
  const blocked = items.filter((item) => item.verdict === "unsupported");
  const unknown = items.filter((item) => item.verdict === "unknown");
  const supported = items.filter((item) => item.verdict === "supported");

  if (!items.length) return null;

  const version = report.clusterVersion ?? "未知";

  return (
    <div className="flex flex-col gap-2">
      {blocked.length ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-800">
          <p className="mb-1 text-(length:--text-app-meta) uppercase tracking-wide text-rose-700">
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
