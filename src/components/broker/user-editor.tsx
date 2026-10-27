import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { Button, Field, Input, Modal } from "@/components/ui";
import { useSaveUser } from "@/hooks/use-admin";
import { badUserName, tagHint, weakPassword } from "@/lib/admin";
import { ASSIGNABLE_TAGS, USER_TAG_LABEL } from "@/types/admin";
import type { UserInfo, UserTag } from "@/types/admin";

/**
 * 用户编辑弹窗。
 *
 * 两处必须显眼：
 * 1. **空标签等于进不去管理界面**。账号建好、密码也对，但服务端不会报错，
 *    只是那个用户永远看不到管理页 —— 所以不选标签时直接在按钮上方警告。
 * 2. **编辑时密码留空等于不改**。这是管理 API 的既定语义，不是本面板的偷懒。
 *
 * 改名也不是原子操作：后端是「先建新的、再删旧的」，中间会有一小段时间这个
 * 账号不存在，正在跑的消费者会掉线重连。
 */
export function UserEditor({
  open,
  user,
  canWrite,
  onClose,
}: {
  open: boolean;
  user: UserInfo | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const save = useSaveUser(connectionId);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [tags, setTags] = useState<UserTag[]>([]);

  useEffect(() => {
    if (!open) return;
    save.reset();
    setName(user?.name ?? "");
    setPassword("");
    setTags(
      (user?.tags ?? [])
        .map((tag) => tag.trim())
        .filter((tag): tag is UserTag => tag in USER_TAG_LABEL && tag !== "none"),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user]);

  const nameProblem = badUserName(name);
  const passwordProblem = weakPassword(name, password);
  const needsPassword = !user && !password;
  const canSave = canWrite && !nameProblem && !needsPassword && !save.isPending;

  const toggle = (tag: UserTag) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));
  };

  return (
    <Modal
      open={open}
      title={user ? `编辑用户 · ${user.name}` : "新建用户"}
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
              save.mutate(
                {
                  spec: { name: name.trim(), password, tags },
                  originalName: user?.name,
                },
                { onSuccess: onClose },
              )
            }
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="用户名" error={nameProblem} hint="改名会先建新账号再删旧账号，期间消费者会掉线重连">
          <Input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="app-orders"
            autoFocus
          />
        </Field>

        <Field
          label="密码"
          error={needsPassword ? "新建用户必须设置密码" : undefined}
          hint={
            user
              ? "留空表示不改密码"
              : "新建必须填。RabbitMQ 存的是加盐哈希，面板这边算好了再提交"
          }
        >
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            placeholder={user ? "不修改" : "至少 8 位"}
            autoComplete="new-password"
          />
        </Field>
        {passwordProblem ? (
          <p className="text-(length:--text-app-body) text-amber-700">
            口令提醒：{passwordProblem}（不阻止保存，服务端也不会管）
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-(length:--text-app-body) text-secondary">标签</span>
          <div className="flex flex-wrap gap-1.5">
            {ASSIGNABLE_TAGS.map((tag) => {
              const active = tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggle(tag)}
                  title={tagHint(tag)}
                  className={
                    active
                      ? "rounded-md border border-indigo-300 bg-indigo-50 px-2 py-1 text-(length:--text-app-meta) text-indigo-700"
                      : "rounded-md border border-slate-200 px-2 py-1 text-(length:--text-app-meta) text-slate-600 hover:bg-slate-50"
                  }
                >
                  {USER_TAG_LABEL[tag]}
                </button>
              );
            })}
          </div>
          {tags.length ? (
            <span className="text-(length:--text-app-meta) text-meta">
              {tagHint(tags[0])}
            </span>
          ) : (
            <span className="text-(length:--text-app-meta) text-amber-700">
              没选标签：这个账号能收发消息，但登不进管理界面，也看不到任何资源
            </span>
          )}
        </div>

        {!canWrite ? (
          <p className="text-(length:--text-app-body) text-amber-700">
            当前账号没有管理 API 写权限，保存会被服务端拒绝
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
