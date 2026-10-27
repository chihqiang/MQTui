import { useState } from "react";

import { Badge, Button, ConfirmDialog } from "@/components/ui";
import { useDeleteConsumerGroups, useGroupRemovalPreflight } from "@/hooks/use-consumer-groups";
import {
  blockedChecks,
  canSubmit,
  checkTone,
  clearChecks,
  memberText,
  preflightHeadline,
} from "@/lib/group-removal";

/**
 * 删除一个消费组。
 *
 * 为什么值得做：组名一多，「这是谁建的组、能不能删」就成了只能靠
 * `kafka-consumer-groups.sh --delete` 回答的问题。而面板刚刚才把这个组
 * 连同它的位点、滞后、成员全摆在你眼前。
 *
 * 为什么敢做成确认框而不是藏起来：删除消费组的失败方式很明确 ——
 * 组里还有在线成员时服务端直接拒绝（`NonEmptyGroup`），什么都不会发生。
 * 真正的风险不是「删错」而是「删掉之后位点没了」：重建同名组会从
 * `auto.offset.reset` 重新开始，那一步由确认框里的说明承担。
 *
 * 预检只在弹窗打开时才跑：它要读一次组成员列表，而「点开看看」不该
 * 每次都先付一次往返。结论也可能已经过期（成员可能刚好上线），所以
 * 它只用来**提前说明**，最终判据仍然是服务端的回执。
 */
export function GroupDeleteButton({
  connectionId,
  group,
  onDeleted,
}: {
  connectionId: string;
  group: string;
  /** 删除成功后调用：弹窗还开着的话，它展示的组已经不存在了。 */
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        删除组
      </Button>
      <GroupDeleteDialog
        open={open}
        connectionId={connectionId}
        group={group}
        onDeleted={onDeleted}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * 弹窗本体。拆出来是因为它按 `open` 挂载：关着的时候不该去读组成员，
 * 而 `useQuery` 的 `enabled` 只能管住请求，管不住组件里那些派生状态。
 */
function GroupDeleteDialog({
  open,
  connectionId,
  group,
  onDeleted,
  onClose,
}: {
  open: boolean;
  connectionId: string;
  group: string;
  onDeleted?: () => void;
  onClose: () => void;
}) {
  const remove = useDeleteConsumerGroups(connectionId);
  const preflight = useGroupRemovalPreflight(connectionId, open ? [group] : []);
  const blocked = blockedChecks(preflight.data);
  const clear = clearChecks(preflight.data);
  const submit = canSubmit(preflight.data);

  return (
    <ConfirmDialog
      open={open}
      danger
      title={`删除消费组 ${group}`}
      confirmLabel={blocked.length ? "仍然尝试删除" : "删除"}
      loading={remove.isPending}
      description={
        <div className="flex flex-col gap-2">
          <span>组内已提交的位点会一起消失，无法恢复。</span>
          <span>
            若之后还有同名组重新连上来，会按 `auto.offset.reset` 从头（或从末尾）开始，
            可能把历史消息重放一遍。
          </span>

          <div className="flex flex-col gap-1 border-t border-slate-200 pt-2">
            <div className="flex items-center gap-2">
              <Badge tone={preflight.isLoading ? "neutral" : "neutral"}>预检</Badge>
              <span className="text-secondary">
                {preflightHeadline(preflight.data, preflight.isError)}
              </span>
            </div>
            {blocked.map((check) => (
              <span key={check.group} className="text-(length:--text-app-body)">
                <Badge tone={checkTone(check)}>{memberText(check)}</Badge>
                <span className="ml-1">{check.reason}</span>
              </span>
            ))}
            {clear.length && !blocked.length ? (
              <span className="text-meta">
                没看出问题 ≠ 一定能删：成员可能刚好在你按下之前上线。
              </span>
            ) : null}
            {preflight.data?.unknown.length ? (
              <span className="text-meta">
                {preflight.data.unknown.length} 个组的成员读不到，不参与拦截。
              </span>
            ) : null}
          </div>

          <span className="text-secondary">
            组里还有在线成员时服务端会拒绝删除，需要先停掉这些消费者。
          </span>
        </div>
      }
      onConfirm={() => {
        // 全部被占着时按钮已禁用；这里再拦一次是防键盘回车绕过按钮状态。
        if (!submit) return;
        remove.mutate([group], {
          onSuccess: (outcome) => {
            onClose();
            // 只有真的删掉了才通知外面：被服务端拒绝时弹窗还得留着，
            // 否则用户会以为删成功了。
            if (outcome.deleted.includes(group)) onDeleted?.();
          },
        });
      }}
      onClose={onClose}
    />
  );
}
