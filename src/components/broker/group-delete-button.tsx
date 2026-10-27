import { useState } from "react";

import { Button, ConfirmDialog } from "@/components/ui";
import { useDeleteConsumerGroups } from "@/hooks/use-consumer-groups";

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
  const remove = useDeleteConsumerGroups(connectionId);

  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        删除组
      </Button>
      <ConfirmDialog
        open={open}
        danger
        title={`删除消费组 ${group}`}
        confirmLabel="删除"
        loading={remove.isPending}
        description={
          <div className="flex flex-col gap-1">
            <span>组内已提交的位点会一起消失，无法恢复。</span>
            <span>
              若之后还有同名组重新连上来，会按 `auto.offset.reset` 从头（或从末尾）开始，
              可能把历史消息重放一遍。
            </span>
            <span className="text-secondary">
              组里还有在线成员时服务端会拒绝删除，需要先停掉这些消费者。
            </span>
          </div>
        }
        onConfirm={() =>
          remove.mutate([group], {
            onSuccess: (outcome) => {
              setOpen(false);
              // 只有真的删掉了才通知外面：被服务端拒绝时弹窗还得留着，
              // 否则用户会以为删成功了。
              if (outcome.deleted.includes(group)) onDeleted?.();
            },
          })
        }
        onClose={() => setOpen(false)}
      />
    </>
  );
}
