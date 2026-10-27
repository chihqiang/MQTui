import { Button, ComboInput, Field, Input } from "@/components/ui";
import { HEADER_NAMES, type HeaderRow } from "@/lib/produce";

/**
 * header 行编辑器：Kafka 与 RabbitMQ 共用。
 *
 * 两边的位置不同 —— Kafka 是 record headers（W3C traceparent、trace-id 这类），
 * RabbitMQ 是 AMQP 的 field table —— 但「一行一个 key=value，空 key 的行丢弃」
 * 这件事一模一样。抄两份的结果是其中一份迟早忘了 trim。
 *
 * key 给候选但允许自己写：header 名不是资源名（没有「这台机器上已有的集合」），
 * 只有几个约定俗成的名字值得点一下；值永远是自由内容，不给候选。
 */
export function HeaderEditor({
  rows,
  onChange,
  hint,
}: {
  rows: HeaderRow[];
  onChange: (next: HeaderRow[]) => void;
  hint: string;
}) {
  return (
    <Field label="Headers（可选）" hint={hint}>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <ComboInput
              value={row.key}
              choices={HEADER_NAMES.map((item) => ({ value: item.value, hint: item.hint }))}
              onValueChange={(next) => {
                const updated = [...rows];
                updated[index] = { ...row, key: next };
                onChange(updated);
              }}
              placeholder="header 名"
              className="min-w-0 flex-1 font-mono"
            />
            <Input
              value={row.value}
              onChange={(event) => {
                const updated = [...rows];
                updated[index] = { ...row, value: event.currentTarget.value };
                onChange(updated);
              }}
              placeholder="值"
              className="min-w-0 flex-1 font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(rows.filter((_, position) => position !== index))}
            >
              删除
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange([...rows, { key: "", value: "" }])}
          >
            加一行 header
          </Button>
        </div>
      </div>
    </Field>
  );
}
