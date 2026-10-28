import { Badge, Button, DataTable, TableCell, TableRow } from "@/components/ui";
import { principalName, resourceLabel } from "@/lib/acl";
import {
  ACL_COLUMNS,
  ACL_OPERATION_LABEL,
  ACL_PERMISSION_LABEL,
  ACL_PRINCIPAL_COLUMNS,
} from "@/types/acl";
import type { AclEntry, AclOperation, PrincipalAcl } from "@/types/acl";

/**
 * ACL 规则表。
 *
 * 拆成两张：一张一行一条（好搜、好排序），一张按主体分组（回答「这个人
 * 到底能做哪些事」）。同一个表样改来改去只会让两边都别扭。
 */

/** 操作格的语气：`全部` 是概括（要留意），读 / 查这类只读操作用信息色。 */
function operationTone(operation: AclOperation): "info" | "warning" | "neutral" {
  if (operation === "all") return "warning";
  if (operation === "read" || operation === "describe" || operation === "describeConfigs") {
    return "info";
  }
  return "neutral";
}

function OperationCell({ operation }: { operation: AclOperation }) {
  return (
    <Badge tone={operationTone(operation)}>{ACL_OPERATION_LABEL[operation]}</Badge>
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
        <TableRow
          key={`${entry.principal}|${entry.resourceType}|${entry.resourceName}|${entry.operation}|${entry.permission}|${entry.host}`}
        >
          <TableCell>
            <span className="font-mono text-slate-800">{principalName(entry.principal)}</span>
          </TableCell>
          <TableCell>{resourceLabel(entry)}</TableCell>
          <TableCell>
            <OperationCell operation={entry.operation} />
          </TableCell>
          <TableCell>
            <PermissionCell permission={entry.permission} />
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
 * 按主体分组：主体名只在该组第一行出现。
 *
 * 同一个人六条规则写六遍 `alice`，会让人以为有六个 alice。
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
          <TableRow
            key={`${group.principal}|${entry.resourceType}|${entry.resourceName}|${entry.operation}|${entry.permission}|${entry.host}`}
          >
            <TableCell>
              {index === 0 ? (
                <span className="font-mono text-slate-800">{principalName(group.principal)}</span>
              ) : (
                <span className="text-meta">·</span>
              )}
            </TableCell>
            <TableCell>{resourceLabel(entry)}</TableCell>
            <TableCell>
              <OperationCell operation={entry.operation} />
            </TableCell>
            <TableCell>
              <PermissionCell permission={entry.permission} />
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
