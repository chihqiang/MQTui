import { Button, Card, CardBody, CardHeader } from "@/components/ui";
import { BROKER_LABEL } from "@/lib/nav";
import {
  deleteSavedConnection,
  listSavedConnections,
  type SavedConnection,
} from "@/lib/session-storage";

interface Props {
  entries: SavedConnection[];
  onUse: (entry: SavedConnection) => void;
  onEdit: (entry: SavedConnection) => void;
  onChange: (next: SavedConnection[]) => void;
}

/** 已保存的连接：一键重连 / 删除。数据来自 localStorage。 */
export function SavedConnectionsCard({ entries, onUse, onEdit, onChange }: Props) {
  const remove = (entry: SavedConnection) => {
    deleteSavedConnection(entry.id);
    onChange(listSavedConnections());
  };

  return (
    <Card>
      <CardHeader title={`已保存的连接（${entries.length}）`} />
      <CardBody className="flex flex-col gap-1.5 p-0">
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 border-b border-slate-800/60 px-4 py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-200">
                  {entry.name}
                  <span className="ml-2 text-[11px] text-slate-500">
                    {BROKER_LABEL[entry.config.kind]}
                  </span>
                </p>
                <p className="truncate font-mono text-[11px] text-slate-500">
                  {describeEndpoint(entry)}
                </p>
              </div>
              <Button size="sm" onClick={() => onUse(entry)}>
                连接
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onEdit(entry)}>
                填入表单
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove(entry)}>
                删除
              </Button>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function describeEndpoint(entry: SavedConnection): string {
  const config = entry.config;
  return config.kind === "kafka"
    ? config.brokers.join(",")
    : `${config.host}:${config.port}${config.auth.vhost === "/" ? "" : config.auth.vhost}`;
}
