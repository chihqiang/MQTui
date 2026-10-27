import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { Button, Empty, Field, Input } from "@/components/ui";
import { useQueues, useTopics } from "@/hooks/use-broker-data";
import { useConnections } from "@/hooks/use-connections";
import { useSessionStore } from "@/stores";
import type { MessageSummary } from "@/types";
import {
  connectionMemoryKey,
  listRecentTargets,
  rememberTarget,
} from "@/lib/workspace-storage";

import { MessageDetailDialog } from "./message-detail";
import { MessageTable } from "./message-table";

/** 消息：输入 topic / queue，拉取最近消息并支持查看详情。 */
export function MessagesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeConnectionId = useSessionStore((state) => state.activeConnectionId);
  const pushToast = useSessionStore((state) => state.pushToast);
  const { data: connections } = useConnections();
  const connection = connections?.find((item) => item.id === activeConnectionId);
  const isKafka = connection?.kind === "kafka";
  const { data: topics } = useTopics(activeConnectionId ?? undefined, isKafka);
  // RabbitMQ 侧用队列列表做输入提示，未配置管理 API 时为空，仍可手输。
  const { data: queues } = useQueues(activeConnectionId ?? undefined, connection?.kind === "rabbitMq");
  const targets = isKafka ? topics?.map((topic) => topic.name) : queues?.map((queue) => queue.name);

  const target = searchParams.get("target") ?? "";
  // 记住每个连接最近看过的 topic / queue，下次进来直接有个候选列表。
  const memoryKey = connection
    ? connectionMemoryKey(connection.kind, connection.endpoint)
    : "";
  const recent = memoryKey ? listRecentTargets(memoryKey) : [];
  const [draft, setDraft] = useState(target);
  // RabbitMQ 的 payload 随列表下发，点开详情时直接带过去，不再回源。
  const [selected, setSelected] = useState<MessageSummary | null>(null);

  useEffect(() => {
    if (target && memoryKey) rememberTarget(memoryKey, target);
  }, [target, memoryKey]);

  // 换连接时把输入框对齐到新的 URL 参数，避免带着上个连接的残留。
  useEffect(() => {
    setDraft(searchParams.get("target") ?? "");
  }, [searchParams]);

  if (!activeConnectionId) {
    return <Empty title="请选择连接" description="在左侧选择一个连接后再查看消息" />;
  }

  return (
    <div className="flex h-full flex-col p-6">
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) {
            pushToast("error", "请填写主题或队列名");
            return;
          }
          setSearchParams({ target: draft.trim() });
        }}
      >
        <div className="w-72">
          <Field label={isKafka ? "Topic" : "Queue"}>
            <Input
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder={isKafka ? "topic 名称" : "queue 名称"}
              list="message-targets"
            />
          </Field>
          <datalist id="message-targets">
            {[...new Set([...(recent ?? []), ...(targets ?? [])])].map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <Button type="submit" size="md">
          读取消息
        </Button>
      </form>

      <div className="min-h-0 flex-1">
        {target ? (
          <MessageTable
            connectionId={activeConnectionId}
            target={target}
            onSelect={setSelected}
          />
        ) : (
          <Empty title="尚未选择数据源" description="输入 topic 或 queue 后回车即可拉取最近消息" />
        )}
      </div>

      {selected ? (
        <MessageDetailDialog
          connectionId={activeConnectionId}
          message={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}