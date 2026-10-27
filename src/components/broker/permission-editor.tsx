import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { Button, Field, Input, Modal, Select } from "@/components/ui";
import { useSavePermission } from "@/hooks/use-admin";
import { FULL_ACCESS, emptySegments, isFullAccess } from "@/lib/admin";
import { SEGMENT_HINT, type PermissionInfo } from "@/types/admin";

/**
 * 权限编辑弹窗：给某个用户在某个 vhost 上开权限。
 *
 * 三段正则必须一起提交：管理 API 是**覆盖**语义，没写的那段会被置空 ——
 * 也就是「这一项什么都不许」。所以界面不能做成「只改 write」。
 *
 * 三段全开（`.*`）是个管理员级的口子，弹窗里要单独说一句：手滑多打一个 `.*`，
 * 普通账号就变成了管理员。
 */
export function PermissionEditor({
  open,
  permission,
  users,
  vhosts,
  canWrite,
  onClose,
}: {
  open: boolean;
  /** 非空表示编辑既有权限，空表示新授权。 */
  permission: PermissionInfo | null;
  users: string[];
  vhosts: string[];
  canWrite: boolean;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const save = useSavePermission(connectionId);
  const [user, setUser] = useState("");
  const [vhost, setVhost] = useState("");
  const [configure, setConfigure] = useState(FULL_ACCESS);
  const [write, setWrite] = useState(FULL_ACCESS);
  const [read, setRead] = useState(FULL_ACCESS);

  useEffect(() => {
    if (!open) return;
    save.reset();
    setUser(permission?.user ?? "");
    setVhost(permission?.vhost ?? vhosts[0] ?? "");
    setConfigure(permission?.configure ?? FULL_ACCESS);
    setWrite(permission?.write ?? FULL_ACCESS);
    setRead(permission?.read ?? FULL_ACCESS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, permission]);

  const draft: PermissionInfo = { user, vhost, configure, write, read };
  const empty = emptySegments(draft);
  const canSave = canWrite && user.trim().length > 0 && vhost.trim().length > 0 && !save.isPending;

  return (
    <Modal
      open={open}
      title={permission ? `编辑权限 · ${permission.user} @ ${permission.vhost}` : "新增权限"}
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
            onClick={() => save.mutate(draft, { onSuccess: onClose })}
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Field label="用户" hint={permission ? "改不了：换个用户等于换一条权限" : undefined}>
            {permission ? (
              <Input value={user} disabled onChange={() => undefined} />
            ) : (
              <Select value={user} onChange={(event) => setUser(event.currentTarget.value)}>
                <option value="">选择用户…</option>
                {users.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="vhost">
            {permission ? (
              <Input value={vhost} disabled onChange={() => undefined} />
            ) : (
              <Select value={vhost} onChange={(event) => setVhost(event.currentTarget.value)}>
                <option value="">选择 vhost…</option>
                {vhosts.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field label="configure" hint={SEGMENT_HINT.configure}>
          <Input value={configure} onChange={(event) => setConfigure(event.currentTarget.value)} />
        </Field>
        <Field label="write" hint={SEGMENT_HINT.write}>
          <Input value={write} onChange={(event) => setWrite(event.currentTarget.value)} />
        </Field>
        <Field label="read" hint={SEGMENT_HINT.read}>
          <Input value={read} onChange={(event) => setRead(event.currentTarget.value)} />
        </Field>

        {empty.length ? (
          <p className="text-(length:--text-app-body) text-amber-700">
            {empty.join(" / ")} 为空：空正则等于「什么都不许」，通常不是本意
          </p>
        ) : null}
        {isFullAccess(draft) ? (
          <p className="text-(length:--text-app-body) text-slate-500">
            三段都是 `.{'*'}`：这个账号在这个 vhost 里等同于管理员，能删掉任何队列与交换机
          </p>
        ) : null}
        {!canWrite ? (
          <p className="text-(length:--text-app-body) text-amber-700">
            当前账号没有管理 API 写权限，保存会被服务端拒绝
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
