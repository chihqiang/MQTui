import { useMemo, useState } from "react";
import { useParams } from "react-router";

import { FilterBar } from "@/components/broker";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Empty,
  ErrorState,
  RefreshButton,
  StaleNotice,
  TableActions,
  TableCell,
  TableRow,
} from "@/components/ui";
import { PermissionEditor } from "@/components/broker/permission-editor";
import { UserEditor } from "@/components/broker/user-editor";
import { VhostEditor } from "@/components/broker/vhost-editor";
import {
  useAdmin,
  useDeletePermission,
  useDeleteUser,
  useDeleteVhost,
} from "@/hooks/use-admin";
import { useHealth } from "@/hooks/use-health";
import { useListFilter } from "@/hooks/use-list-filter";
import {
  canLogin,
  describeTags,
  describeVhost,
  emptySegments,
  isFullAccess,
  loginTone,
  permissionRemovalWarning,
  userMatches,
  userRemovalBlock,
  vhostRemovalBlock,
  vhostRemovalWarning,
} from "@/lib/admin";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import { PERMISSION_COLUMNS, USER_COLUMNS, VHOST_COLUMNS } from "@/types/admin";
import type { PendingRemoval, PermissionInfo, UserInfo, VhostRow } from "@/types/admin";

/**
 * RabbitMQ 账户管理：vhost、用户、权限。
 *
 * 这三样是 rabbitmq management 面板的核心一屏，缺了它，多 vhost 环境下的
 * 建队列、分权限就只能去控制台。这一页把它们放在一起，因为权限本身就是
 * 「用户 × vhost」的交叉表 —— 分开成三页反而要来回跳。
 *
 * 三个不可逆或容易踩的动作都在这里显式说清后果：
 * - 删 vhost：队列、消息、权限、策略一起消失，没有回收站；
 * - 删用户：连带它在所有 vhost 上的权限，删掉当前账号等于把自己锁在门外；
 * - 撤销权限：不是「限制」而是「停止」，正在跑的消费者会立刻掉线。
 */
export function AdminPage() {
  const { connectionId } = useParams();
  const { data, isLoading, error, refetch } = useAdmin(connectionId);
  const { canWrite } = useHealth(connectionId);
  const [keyword, setKeyword] = useListFilter();

  const [vhostEditor, setVhostEditor] = useState<{ open: boolean; target: VhostRow | null }>({
    open: false,
    target: null,
  });
  const [userEditor, setUserEditor] = useState<{ open: boolean; target: UserInfo | null }>({
    open: false,
    target: null,
  });
  const [permissionEditor, setPermissionEditor] = useState<{
    open: boolean;
    target: PermissionInfo | null;
  }>({ open: false, target: null });
  const [removing, setRemoving] = useState<PendingRemoval | null>(null);

  const users = useMemo(() => {
    if (!data) return [];
    return data.users.filter((user) => userMatches(user, keyword));
  }, [data, keyword]);

  const vhosts = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    if (!needle) return data.vhosts;
    return data.vhosts.filter((row) =>
      [row.name, row.description].join(" ").toLowerCase().includes(needle),
    );
  }, [data, keyword]);

  if (error && !data) {
    return (
      <ErrorState
        message={failureText("读取账户信息", errorMessage(error))}
        onRetry={() => void refetch()}
      />
    );
  }

  // 账户管理整个建立在管理插件之上。未配置时后端直接报错，这里给出出路，
  // 而不是干巴巴一句「加载失败」。
  if (!data && !isLoading) {
    return (
      <Empty
        title="账户管理需要 RabbitMQ 管理插件"
        description="请在连接配置里填写管理 API 地址（默认 15672 端口），否则无法读写 vhost、用户与权限"
      />
    );
  }

  const writeHint = canWrite ? undefined : "当前账号没有管理 API 写权限";

  return (
    <PageBody>
      <PageHeader
        title="账户"
        description="vhost、用户与权限；删 vhost 会连带删掉里面的队列与消息，不可撤销"
        actions={
          <RefreshButton
            state={{ firstLoad: !data, refreshing: isLoading, hasData: Boolean(data) }}
            onRefresh={() => void refetch()}
          />
        }
      />

      {error && data ? (
        <StaleNotice
          message={failureText("刷新账户信息", errorMessage(error))}
          onRetry={() => void refetch()}
        >
          下面是上一次读到的结果
        </StaleNotice>
      ) : null}

      {data?.notes.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-(length:--text-app-body) text-amber-800">
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <PageToolbar
        hint={
          data
            ? `当前连接使用账号 ${data.currentUser}，vhost ${data.currentVhost}；两者都删不得`
            : undefined
        }
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite || isLoading}
            title={writeHint}
            onClick={() => setVhostEditor({ open: true, target: null })}
          >
            新建 vhost
          </Button>
        }
      >
        <FilterBar
          value={keyword}
          onValueChange={setKeyword}
          placeholder="按名称 / 描述 / 标签过滤"
          ariaLabel="过滤账户"
        />
      </PageToolbar>

      <Card>
        <CardHeader title={`vhost（${isLoading ? "…" : vhosts.length}）`} />
        <CardBody className="p-0">
          {isLoading || vhosts.length ? (
            <DataTable columns={VHOST_COLUMNS} loadingRows={isLoading ? 3 : undefined}>
              {vhosts.map((row) => (
                <VhostTableRow
                  key={row.name}
                  row={row}
                  currentVhost={data?.currentVhost ?? ""}
                  canWrite={canWrite}
                  onEdit={() => setVhostEditor({ open: true, target: row })}
                  onRemove={() => setRemoving({ kind: "vhost", row })}
                />
              ))}
            </DataTable>
          ) : (
            <Empty
              title={keyword ? "没有匹配的 vhost" : "还没有 vhost"}
              description={keyword ? undefined : "默认 vhost `/` 通常已经在，其余按业务隔离建"}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`用户（${isLoading ? "…" : users.length}）`}
          extra={
            <Button
              size="sm"
              disabled={!canWrite || isLoading}
              title={writeHint}
              onClick={() => setUserEditor({ open: true, target: null })}
            >
              新建用户
            </Button>
          }
        />
        <CardBody className="p-0">
          {isLoading || users.length ? (
            <DataTable columns={USER_COLUMNS} loadingRows={isLoading ? 3 : undefined}>
              {users.map((user) => (
                <UserTableRow
                  key={user.name}
                  user={user}
                  currentUser={data?.currentUser ?? ""}
                  canWrite={canWrite}
                  onEdit={() => setUserEditor({ open: true, target: user })}
                  onRemove={() => setRemoving({ kind: "user", user })}
                />
              ))}
            </DataTable>
          ) : (
            <Empty
              title={keyword ? "没有匹配的用户" : "还没有用户"}
              description={keyword ? undefined : "面板里的连接账号通常就是这里最早的那一个"}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`权限（${
            data?.permissions ? data.permissions.length : isLoading ? "…" : "看不到"
          }）`}
          extra={
            <Button
              size="sm"
              disabled={!canWrite || isLoading || !data?.permissions}
              title={writeHint ?? (data?.permissions ? undefined : "当前账号看不到权限列表")}
              onClick={() => setPermissionEditor({ open: true, target: null })}
            >
              新增权限
            </Button>
          }
        />
        <CardBody className="p-0">
          {!data?.permissions ? (
            <p className="px-4 py-3 text-(length:--text-app-body) text-slate-500">
              {isLoading
                ? "读取中…"
                : "当前账号看不到权限列表（需要 administrator 标签）。没有权限记录 ≠ 看不到权限记录，所以这里不显示「0 条」"}
            </p>
          ) : data.permissions.length ? (
            <DataTable columns={PERMISSION_COLUMNS}>
              {data.permissions.map((permission) => (
                <PermissionTableRow
                  key={`${permission.vhost}/${permission.user}`}
                  permission={permission}
                  canWrite={canWrite}
                  onEdit={() => setPermissionEditor({ open: true, target: permission })}
                  onRemove={() => setRemoving({ kind: "permission", permission })}
                />
              ))}
            </DataTable>
          ) : (
            <Empty
              title="还没有任何权限"
              description="除了默认的 guest，其他账号都要在这里显式授权才能收发消息"
            />
          )}
        </CardBody>
      </Card>

      <VhostEditor
        open={vhostEditor.open}
        vhost={vhostEditor.target}
        canWrite={canWrite}
        onClose={() => setVhostEditor({ open: false, target: null })}
      />
      <UserEditor
        open={userEditor.open}
        user={userEditor.target}
        canWrite={canWrite}
        onClose={() => setUserEditor({ open: false, target: null })}
      />
      <PermissionEditor
        open={permissionEditor.open}
        permission={permissionEditor.target}
        users={(data?.users ?? []).map((user) => user.name)}
        vhosts={(data?.vhosts ?? []).map((row) => row.name)}
        canWrite={canWrite}
        onClose={() => setPermissionEditor({ open: false, target: null })}
      />

      {removing ? (
        <RemovalDialog pending={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </PageBody>
  );
}

function VhostTableRow({
  row,
  currentVhost,
  canWrite,
  onEdit,
  onRemove,
}: {
  row: VhostRow;
  currentVhost: string;
  canWrite: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const block = vhostRemovalBlock(row, currentVhost);
  return (
    <TableRow>
      <TableCell mono className="text-slate-800">
        {row.name}
        {row.name === currentVhost ? (
          <span className="ml-2 font-sans text-(length:--text-app-meta) text-slate-500">当前</span>
        ) : null}
      </TableCell>
      <TableCell muted>{row.description || "-"}</TableCell>
      <TableCell muted numeric>
        {row.queues}
      </TableCell>
      <TableCell numeric>
        {row.permissions}
        {row.fullAccess ? (
          <span className="ml-1 text-(length:--text-app-meta) text-amber-700">全开 {row.fullAccess}</span>
        ) : null}
      </TableCell>
      <TableCell>
        <TableActions>
          <Button size="sm" variant="secondary" disabled={!canWrite} onClick={onEdit}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canWrite || Boolean(block)}
            title={block ?? "删除不可撤销"}
            onClick={onRemove}
          >
            删除
          </Button>
        </TableActions>
      </TableCell>
    </TableRow>
  );
}

function UserTableRow({
  user,
  currentUser,
  canWrite,
  onEdit,
  onRemove,
}: {
  user: UserInfo;
  currentUser: string;
  canWrite: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const block = userRemovalBlock(user, currentUser);
  return (
    <TableRow>
      <TableCell mono className="text-slate-800">
        {user.name}
        {user.name === currentUser ? (
          <span className="ml-2 font-sans text-(length:--text-app-meta) text-slate-500">当前</span>
        ) : null}
      </TableCell>
      <TableCell muted>{describeTags(user)}</TableCell>
      <TableCell>
        <Badge tone={loginTone(user)}>{canLogin(user) ? "可登录" : "不可登录"}</Badge>
      </TableCell>
      <TableCell>
        <TableActions>
          <Button size="sm" variant="secondary" disabled={!canWrite} onClick={onEdit}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canWrite || Boolean(block)}
            title={block ?? "会连带删除它在所有 vhost 上的权限"}
            onClick={onRemove}
          >
            删除
          </Button>
        </TableActions>
      </TableCell>
    </TableRow>
  );
}

function PermissionTableRow({
  permission,
  canWrite,
  onEdit,
  onRemove,
}: {
  permission: PermissionInfo;
  canWrite: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const empty = emptySegments(permission);
  return (
    <TableRow>
      <TableCell mono className="text-slate-800">
        {permission.user}
      </TableCell>
      <TableCell mono muted>
        {permission.vhost}
      </TableCell>
      <TableCell mono muted>
        {permission.configure || "（空）"}
      </TableCell>
      <TableCell mono muted>
        {permission.write || "（空）"}
      </TableCell>
      <TableCell mono muted>
        {permission.read || "（空）"}
        {isFullAccess(permission) ? (
          <span className="ml-2 font-sans text-(length:--text-app-meta) text-amber-700">全开</span>
        ) : null}
        {empty.length ? (
          <span className="ml-2 font-sans text-(length:--text-app-meta) text-slate-500">
            {empty.join("/")} 为空
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <TableActions>
          <Button size="sm" variant="secondary" disabled={!canWrite} onClick={onEdit}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canWrite}
            title="撤销后该用户在这个 vhost 里什么都做不了"
            onClick={onRemove}
          >
            撤销
          </Button>
        </TableActions>
      </TableCell>
    </TableRow>
  );
}

/** 三种删除共用同一个确认框，因为共同点是「不可逆、要手打名字」。 */
function RemovalDialog({
  pending,
  onClose,
}: {
  pending: PendingRemoval;
  onClose: () => void;
}) {
  const { connectionId } = useParams();
  const removeVhost = useDeleteVhost(connectionId);
  const removeUser = useDeleteUser(connectionId);
  const removePermission = useDeletePermission(connectionId);

  const loading =
    removeVhost.isPending || removeUser.isPending || removePermission.isPending;

  if (pending.kind === "vhost") {
    return (
      <ConfirmDialog
        open
        danger
        title="删除 vhost"
        confirmLabel="删除 vhost"
        requirePhrase={pending.row.name}
        loading={loading}
        description={
          <>
            <p>{vhostRemovalWarning(pending.row)}</p>
            <p className="mt-1 text-(length:--text-app-meta) text-slate-500">
              {describeVhost(pending.row)}
            </p>
          </>
        }
        onConfirm={() =>
          removeVhost.mutate(pending.row.name, { onSettled: onClose })
        }
        onClose={onClose}
      />
    );
  }

  if (pending.kind === "user") {
    return (
      <ConfirmDialog
        open
        danger
        title="删除用户"
        confirmLabel="删除用户"
        requirePhrase={pending.user.name}
        loading={loading}
        description={
          <>
            删除用户 <span className="font-mono text-slate-800">{pending.user.name}</span>
            ，同时删掉它在所有 vhost 上的权限。已经建立的连接不会立刻断开，
            但下一次重新连接就会失败。
          </>
        }
        onConfirm={() => removeUser.mutate(pending.user.name, { onSettled: onClose })}
        onClose={onClose}
      />
    );
  }

  const permission = pending.permission;
  return (
    <ConfirmDialog
      open
      danger
      title="撤销权限"
      confirmLabel="撤销权限"
      loading={loading}
      description={permissionRemovalWarning(permission)}
      onConfirm={() =>
        removePermission.mutate(
          { user: permission.user, vhost: permission.vhost },
          { onSettled: onClose },
        )
      }
      onClose={onClose}
    />
  );
}
