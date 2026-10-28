import { Badge, Button, DataTable, TableCell, TableRow } from "@/components/ui";
import { principalName, resourceNameLabel } from "@/lib/acl";
import {
  ACL_COLUMNS,
  ACL_OPERATION_LABEL,
  ACL_PERMISSION_LABEL,
  ACL_PRINCIPAL_COLUMNS,
  ACL_RESOURCE_LABEL,
} from "@/types/acl";
import type { AclEntry, AclOperation, PrincipalAcl } from "@/types/acl";

/**
 * ACL 规则表。
 *
 * 拆成两张：一张一行一条（好搜、好排序），一张按主体分组（回答「这个人
 * 到底能做哪些事」）。同一个表样改来改去只会让两边都别扭。
 */

/**
 * 操作格的语气：`全部` 是概括（要留意），读 / 查这类只读操作用信息色。
 *
 * 只读用 `success` 而不是 `info`：颜色在这张表里的含义是「多危险」，
 * 不是「属于哪一类」。整表扫下去，绿的是只读、灰的是写、黄的是全权 ——
 * 这比读每个标签的字要快一步。
 */
function operationTone(operation: AclOperation): "success" | "warning" | "neutral" {
  if (operation === "all") return "warning";
  if (operation === "read" || operation === "describe" || operation === "describeConfigs") {
    return "success";
  }
  return "neutral";
}

/**
 * 操作 + 权限挤在同一行。
 *
 * 分开两列时 `读` 和 `允许` 之间隔着一整列的白，视线要横跳一次才能拼出
 * 「允许读」；而这一格里真正有信息量的组合只有四种：允许读、允许写、
 * 拒绝一切、其它。合成一格之后一行只读一次。
 */
function GrantCell({ entry }: { entry: AclEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={operationTone(entry.operation)}>{ACL_OPERATION_LABEL[entry.operation]}</Badge>
      <PermissionCell permission={entry.permission} />
    </div>
  );
}

function PermissionCell({ permission }: { permission: AclEntry["permission"] }) {
  return (
    <Badge tone={permission === "deny" ? "danger" : "success"}>
      {ACL_PERMISSION_LABEL[permission]}
    </Badge>
  );
}

function HostCell({ host }: { host: string }) {
  return <span className="font-mono text-meta">{host}</span>;
}

/** 行内操作。两个动作都从现有规则派生，不需要用户重新填六个字段。 */
export type AclRowAction = (entry: AclEntry) => void;

/**
 * 行内操作列。
 *
 * 只给两个最简单的派生动作：删掉这条、把权限翻成相反。
 * 其它改动（换资源、换操作）都走「新建」—— 从既有规则派生的前提是
 * 用户知道自己在复制哪一条，改多了就不是派生了。
 */
function ActionCell({
  entry,
  onDelete,
  onInvert,
}: {
  entry: AclEntry;
  onDelete?: AclRowAction;
  onInvert?: AclRowAction;
}) {
  if (!onDelete && !onInvert) return null;
  return (
    <div className="flex justify-end gap-1">
      {onInvert ? (
        <Button size="sm" variant="ghost" onClick={() => onInvert(entry)}>
          翻权限
        </Button>
      ) : null}
      {onDelete ? (
        <Button size="sm" variant="ghost" onClick={() => onDelete(entry)}>
          删除
        </Button>
      ) : null}
    </div>
  );
}

const ACTION_COLUMN = [{ key: "action", label: "", width: "w-40" }] as const;

/** 扁平表：一行一条规则，主体每行都写。 */
export function AclTable({
  entries,
  loading,
  onDelete,
  onInvert,
}: {
  entries: AclEntry[];
  loading?: boolean;
  onDelete?: AclRowAction;
  onInvert?: AclRowAction;
}) {
  const columns = onDelete || onInvert ? [...ACL_COLUMNS, ...ACTION_COLUMN] : ACL_COLUMNS;
  if (loading) return <DataTable columns={columns} loadingRows={3} />;
  return (
    <DataTable columns={columns}>
      {entries.map((entry) => (
        <TableRow key={rowKey(entry)}>
          <TableCell>
            <span className="font-mono text-slate-800">{principalName(entry.principal)}</span>
          </TableCell>
          <TableCell>
            <ResourceTypeCell entry={entry} />
          </TableCell>
          <TableCell>
            <ResourceNameCell entry={entry} />
          </TableCell>
          <TableCell>
            <GrantCell entry={entry} />
          </TableCell>
          <TableCell>
            <HostCell host={entry.host} />
          </TableCell>
          {columns.length > ACL_COLUMNS.length ? (
            <TableCell>
              <ActionCell entry={entry} onDelete={onDelete} onInvert={onInvert} />
            </TableCell>
          ) : null}
        </TableRow>
      ))}
    </DataTable>
  );
}

/**
 * 按主体分组：主体名只在整块的**第一行**出现，其余行留白。
 *
 * 同一个人六条规则写六遍 `alice`，会让人以为有六个 alice；更糟的是每行
 * 都以 `alice` 开头时，眼睛会顺着第一列往下走，把「alice 能做什么」
 * 读成一串各自独立的规则。以前这里点一个居中的 `·`，那个圆点既不像分隔
 * 也不像省略，落在等宽字体里跟正文一样重，反而更抢眼 —— 现在干脆留空。
 */
export function AclPrincipalTable({
  groups,
  onDelete,
  onInvert,
}: {
  groups: PrincipalAcl[];
  onDelete?: AclRowAction;
  onInvert?: AclRowAction;
}) {
  const columns =
    onDelete || onInvert ? [...ACL_PRINCIPAL_COLUMNS, ...ACTION_COLUMN] : ACL_PRINCIPAL_COLUMNS;
  return (
    <DataTable columns={columns}>
      {groups.flatMap((group) =>
        group.entries.map((entry, index) => (
          <TableRow key={rowKey(entry)}>
            <TableCell>
              {index === 0 ? (
                <span className="font-mono text-slate-800">{principalName(group.principal)}</span>
              ) : null}
            </TableCell>
            <TableCell>
              <ResourceTypeCell entry={entry} />
            </TableCell>
            <TableCell>
              <ResourceNameCell entry={entry} />
            </TableCell>
            <TableCell>
              <GrantCell entry={entry} />
            </TableCell>
            <TableCell>
              <HostCell host={entry.host} />
            </TableCell>
            {columns.length > ACL_PRINCIPAL_COLUMNS.length ? (
              <TableCell>
                <ActionCell entry={entry} onDelete={onDelete} onInvert={onInvert} />
              </TableCell>
            ) : null}
          </TableRow>
        )),
      )}
    </DataTable>
  );
}

/** 资源类型格。类型已经有单独一列，这里只写类型，不再重复名字。 */
function ResourceTypeCell({ entry }: { entry: AclEntry }) {
  return (
    <span className="text-(length:--text-app-body) text-slate-600">
      {ACL_RESOURCE_LABEL[entry.resourceType]}
    </span>
  );
}

/**
 * 资源名格。
 *
 * 通配给一个 `*`（空一格读起来像数据缺了），前缀在名字后面缀一句「前缀匹配」
 * —— 名字末尾那个横线太细，不缀一句很容易被当成名字的一部分，
 * 「这一条覆盖了整个前缀」就看不出来了。集群级资源的名字是 `kafka-cluster`，
 * 但它由类型表达，格子里留空就行。
 */
function ResourceNameCell({ entry }: { entry: AclEntry }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="font-mono text-(length:--text-app-body) text-slate-800">
        {resourceNameLabel(entry)}
      </span>
      {entry.pattern === "prefixed" ? <span className="text-meta">前缀匹配</span> : null}
    </div>
  );
}

/** 行的身份：一条规则的全部字段拼起来，同一主体的两条规则不会撞键。 */
function rowKey(entry: AclEntry): string {
  return [entry.principal, entry.resourceType, entry.resourceName, entry.operation, entry.permission, entry.host].join(
    "|",
  );
}
