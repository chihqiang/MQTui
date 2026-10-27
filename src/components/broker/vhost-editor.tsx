import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { Button, Field, Input, Modal } from "@/components/ui";
import { useSaveVhost } from "@/hooks/use-admin";
import type { VhostRow } from "@/types/admin";

/**
 * vhost 编辑弹窗。
 *
 * 管理 API 用的是 PUT，所以「新建」与「改描述」是同一个动作：名字已存在时
 * 服务端会把描述替换掉，不会有任何提示。这一点必须写在弹窗里 —— 拼错一个
 * 名字然后按下保存，改掉的是别人的描述，事后极难发现。
 */
export function VhostEditor({
  open,
  vhost,
  canWrite,
  onClose,
}: {
  open: boolean;
  /** 非空表示编辑既有 vhost，空表示新建。 */
  vhost: VhostRow | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const save = useSaveVhost(connectionId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // 弹窗常驻，只在 open / 目标变化时重置。
  useEffect(() => {
    if (!open) return;
    save.reset();
    setName(vhost?.name ?? "");
    setDescription(vhost?.description ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vhost]);

  const trimmed = name.trim();
  const canSave = canWrite && trimmed.length > 0 && !save.isPending;

  return (
    <Modal
      open={open}
      title={vhost ? `编辑 vhost · ${vhost.name}` : "新建 vhost"}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() =>
              save.mutate({ name: trimmed, description }, { onSuccess: onClose })
            }
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="名称"
          hint={
            vhost
              ? "改名等于新建一个 vhost 再删掉旧的，这里不支持改名"
              : "名字一旦定下就改不了；已存在时保存等于改描述，不会新建"
          }
        >
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="orders"
            disabled={Boolean(vhost)}
            autoFocus
          />
        </Field>
        <Field label="描述" hint="只给人看，不影响任何行为">
          <Input
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            placeholder="订单业务的 vhost"
          />
        </Field>
        {!canWrite ? (
          <p className="text-(length:--text-app-body) text-amber-700">
            当前账号没有管理 API 写权限，保存会被服务端拒绝
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
