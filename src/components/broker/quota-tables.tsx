import {
  Badge,
  DataTable,
  TableCell,
  TableRow,
} from "@/components/ui";
import {
  iterationsText,
  kindLabel,
  missingMechanisms,
  quotaKeyLabel,
  quotaValueText,
  scramVerdict,
} from "@/lib/quota";
import { QUOTA_COLUMNS, SCRAM_COLUMNS } from "@/types/quota";
import type { QuotaGroup, ScramUser } from "@/types/quota";

/**
 * 配额与 SCRAM 两张表。
 *
 * 从页面里搬出来不是为了「目录整齐」：配额表一个实体要占好几行（每个配额项
 * 一行），凭据表要按机制各画一格，两处的排版规则都足够细，混在页面里会让
 * 「这一页在说什么」被表格细节淹掉。
 */

/** 一个实体的全部配额项。 */
export function QuotaGroupRows({ group }: { group: QuotaGroup }) {
  return (
    <>
      {group.items.map((item, index) => (
        <TableRow key={`${group.label}-${item.key}`}>
          {/* 实体名只在每块第一行出现：同一个实体的几项配额挤在一起时，
              重复写六遍「alice · 全部客户端」只会让人以为有六个 alice。 */}
          <TableCell>
            {index === 0 ? (
              <span className="font-mono text-slate-800">{group.label}</span>
            ) : (
              <span className="text-meta">·</span>
            )}
          </TableCell>
          <TableCell>
            <Badge tone={group.kind === "default" ? "neutral" : "info"}>
              {kindLabel(group.kind)}
            </Badge>
          </TableCell>
          <TableCell>{quotaKeyLabel(item.key)}</TableCell>
          <TableCell align="right">
            <span className="font-mono text-slate-800">{quotaValueText(item)}</span>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

/** 一个用户的一行凭据。 */
export function ScramRow({ user }: { user: ScramUser }) {
  const missing = missingMechanisms(user);

  return (
    <TableRow>
      <TableCell>
        <span className="font-mono text-slate-800">{user.user}</span>
      </TableCell>
      <TableCell>{credentialCell(user, "sha256")}</TableCell>
      <TableCell>{credentialCell(user, "sha512")}</TableCell>
      <TableCell>
        <Badge tone={user.error ? "danger" : missing.length ? "warning" : "success"}>
          {user.error ? "读取失败" : scramVerdict(user)}
        </Badge>
        {user.error ? (
          <span className="ml-2 text-meta">{user.error}</span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

/**
 * 一种机制的格子。
 *
 * 「缺」和「读失败」用不同说法：前者能补凭据，后者只能去查权限 ——
 * 混成同一个虚线，用户会去补一个本来就有的凭据。
 */
function credentialCell(user: ScramUser, mechanism: "sha256" | "sha512") {
  if (user.error) return <span className="text-meta">—</span>;
  const found = user.credentials.find((item) => item.mechanism === mechanism);
  if (!found) return <span className="text-warning">缺</span>;
  return <span className="font-mono text-slate-700">{iterationsText(found.iterations)}</span>;
}

/** 配额表（骨架态也走这里，列宽才不会跳）。 */
export function QuotaTable({
  groups,
  loading,
}: {
  groups: QuotaGroup[];
  loading?: boolean;
}) {
  if (loading) return <DataTable columns={QUOTA_COLUMNS} loadingRows={3} />;
  return (
    <DataTable columns={QUOTA_COLUMNS}>
      {groups.map((group) => (
        <QuotaGroupRows key={group.label} group={group} />
      ))}
    </DataTable>
  );
}

export function ScramTable({ users, loading }: { users: ScramUser[]; loading?: boolean }) {
  if (loading) return <DataTable columns={SCRAM_COLUMNS} loadingRows={3} />;
  return (
    <DataTable columns={SCRAM_COLUMNS}>
      {users.map((user) => (
        <ScramRow key={user.user} user={user} />
      ))}
    </DataTable>
  );
}
