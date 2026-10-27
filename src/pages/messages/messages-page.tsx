import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import { Button, Empty, Input, Segmented } from "@/components/ui";
import { PageBody, PageHeader, PageToolbar } from "@/components/layout/page-header";
import { IconSearch } from "@/lib/icons";
import { chipOverflow } from "@/lib/list-view";
import { useQueues, useTopics } from "@/hooks/use-broker-data";
import { useConnections } from "@/hooks/use-connections";
import {
  connectionMemoryKey,
  listRecentTargets,
  rememberTarget,
} from "@/lib/workspace-storage";
import { useSessionStore } from "@/stores";
import type { MessageSummary } from "@/types";

import { MessageDetailDialog } from "@/pages/messages/message-detail";
import { MessageLocatePanel } from "@/pages/messages/message-locate-panel";
import { MessageTable } from "@/pages/messages/message-table";

/** 候选 chip 的平铺上限（「更多」另外占一格）。 */
const VISIBLE_CHIPS = 6;

/** 浏览与定位是两种不同的读法：一个往下翻，一个按条件扫。 */
type Mode = "browse" | "locate";

const MODES = [
  { value: "browse", label: "浏览" },
  { value: "locate", label: "按 key / 时间定位", title: "顺序扫描分区，适合「找那条消息」" },
] as const;

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
  const [mode, setMode] = useState<Mode>("browse");

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

  const candidates = [...new Set([...recent, ...(targets ?? [])])];

  return (
    <PageBody>
      <PageHeader
        title="消息"
        description={
          isKafka
            ? "按主题浏览最近消息，或按 key / 时间区间定位"
            : "按队列浏览消息；读取后消息会被放回队列，不会丢失"
        }
      />

      {/*
        工具条是三段：左边「数据源输入 + 最近候选」，右边「读法 + 主操作」。

        以前候选 chip 被塞进 `PageToolbar` 的 children 里，和输入框同一行往右
        排 —— 输入框右边紧贴着一串胶囊，看着像输入框的一部分，而真正的主操作
        「读取消息」被推到最右，中间隔着五六个 chip。现在候选独立成一行、
        放在输入框下方并左对齐：它是「输入框的候选值」，位置上就该属于输入框。
        浏览 / 定位这个分段控件也挪到主操作旁边 —— 它决定的是「按什么方式读」，
        是动作的一部分，不属于页头的装饰。
      */}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) {
            pushToast("error", "请填写主题或队列名");
            return;
          }
          setSearchParams({ target: draft.trim() });
        }}
      >
        <PageToolbar
          actions={
            <>
              {target && isKafka ? (
                <Segmented options={[...MODES]} value={mode} onChange={setMode} />
              ) : null}
              <Button type="submit">读取消息</Button>
            </>
          }
        >
          <div className="relative w-72">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder={isKafka ? "输入 topic 名称后回车" : "输入 queue 名称后回车"}
              aria-label={isKafka ? "Topic" : "Queue"}
              list="message-targets"
              className="h-8.5 pl-8"
            />
            <IconSearch
              size={13}
              className="pointer-events-none absolute top-0 bottom-0 left-0 my-auto ml-2.5 text-meta"
            />
            <datalist id="message-targets">
              {candidates.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </PageToolbar>

        {/* 最近的候选一键切换：翻来覆去对照同一批 topic 时比重新输入快得多。
            超过上限不再一刀切截掉 —— 藏起来的候选要能数得出来、点得到，
            否则用户永远不知道还有第 7 个。 */}
        {candidates.length ? (
          <ChipStrip
            candidates={candidates}
            target={target}
            onPick={(name) => setSearchParams({ target: name })}
          />
        ) : null}
      </form>

      <div className="min-h-0 flex-1">
        {target ? (
          mode === "locate" && isKafka ? (
            <MessageLocatePanel
              connectionId={activeConnectionId}
              target={target}
              onSelect={setSelected}
            />
          ) : (
            <MessageTable
              connectionId={activeConnectionId}
              target={target}
              onSelect={setSelected}
              // 重投 / 移入死信是 AMQP 的概念，Kafka 的消息只能再 produce 一条新的。
              canDispose={!isKafka}
              // 反过来，重发只对 Kafka 有意义：AMQP 那边叫重投，语义也不同。
              canResend={isKafka}
            />
          )
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
    </PageBody>
  );
}

/**
 * 候选 chip 条。
 *
 * 三个细节：
 * 1. 平铺到上限之后留一格给「更多 +N」，**N 是数出来的**，不是一句「还有更多」；
 * 2. 超出部分进一个原生 `popover` 菜单，用 `showPopover` 而不是自己管
 *    open/close —— 点外面自动关、Esc 自动关、不被父元素的 `overflow` 裁掉，
 *    这三件事手写一个下拉都要各踩一遍；
 * 3. 当前候选永远平铺在最前：它是「你现在在哪」的锚点，不能藏在菜单里。
 */
function ChipStrip({
  candidates,
  target,
  onPick,
}: {
  candidates: string[];
  target: string;
  onPick: (name: string) => void;
}) {
  // 当前候选排到最前，保证它一定在平铺区里。
  const ordered = target && candidates.includes(target)
    ? [target, ...candidates.filter((name) => name !== target)]
    : candidates;
  const { visible, hidden } = chipOverflow(ordered.length, VISIBLE_CHIPS, 1);
  const shown = ordered.slice(0, visible);
  const rest = ordered.slice(visible);

  return (
    // 单独一行、左对齐、与输入框同宽起步：这排东西是「输入框的候选值」，
    // 和输入框左边对齐才读得出来源。以前它是 `flex-1` 挤在工具条中间，
    // 输入框右边紧贴着一串胶囊，看着像输入框的一部分。
    <div className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onPick(name)}
          title={name}
          className={
            name === target
              ? "max-w-48 truncate rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-mono text-(length:--text-app-meta) text-indigo-700"
              : "max-w-48 truncate rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-(length:--text-app-meta) text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
          }
        >
          {name}
        </button>
      ))}
      {hidden ? (
        <>
          <button
            type="button"
            popoverTarget="message-targets-more"
            className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-(length:--text-app-meta) text-secondary transition-colors hover:border-slate-300 hover:text-slate-900"
            title={`还有 ${hidden} 个候选`}
          >
            更多 {hidden}
          </button>
          <ul
            id="message-targets-more"
            popover="auto"
            className="mt-1 max-h-72 min-w-56 overflow-auto rounded-md border border-slate-300 bg-white p-1 shadow-lg"
          >
            {rest.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => onPick(name)}
                  className="w-full truncate rounded px-2 py-1 text-left font-mono text-(length:--text-app-meta) text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
