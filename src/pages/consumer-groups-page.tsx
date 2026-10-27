import { useState } from "react";
import { useParams } from "react-router";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorState,
  Input,
} from "@/components/ui";
import { useConsumerGroups } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { formatLag, groupState, lagTone } from "@/lib/consumer";
import { formatNumber } from "@/lib/format";
import type { ConsumerGroupInfo } from "@/types";

import { ConsumerGroupDialog } from "./consumer-group-detail";

/**
 * Kafka 消费组列表。
 *
 * 列表页只展示「组名 / 状态 / 成员数」，滞后量要逐分区查水位，
 * 代价与组数成正比，因此留给详情页按需计算 —— 打开一眼就能看懂，
 * 又不会因为集群里有几百个组而拖慢首屏。
 */
export function ConsumerGroupsPage() {
  const { connectionId } = useParams();
  const [keyword, setKeyword] = useState("");
  const [draft, setDraft] = useState("");
  const [selected, setSelected] = useState<ConsumerGroupInfo | null>(null);

  const {
    data,
    isLoading,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useConsumerGroups(connectionId, keyword);

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex h-full flex-col p-6">
      <form
        className="mb-4 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setKeyword(draft.trim());
        }}
      >
        <div className="w-72">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="按组名过滤（不区分大小写）"
            aria-label="消费组关键字"
          />
        </div>
        <Button type="submit" size="md">
          过滤
        </Button>
        {keyword ? (
          <Button
            type="button"
            size="md"
            variant="ghost"
            onClick={() => {
              setDraft("");
              setKeyword("");
            }}
          >
            清除
          </Button>
        ) : null}
      </form>

      {isLoading ? (
        <p className="p-4 text-sm text-slate-400">读取消费组中…</p>
      ) : error ? (
        <ErrorState
          message={errorMessage(error)}
          onRetry={() => void refetch()}
        />
      ) : !items.length ? (
        <Empty
          title={keyword ? "没有匹配的消费组" : "没有消费组"}
          description={
            keyword
              ? `没有组名包含「${keyword}」，换个关键字试试`
              : "该集群尚未有消费者提交位点"
          }
        />
      ) : (
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader
            title={`消费组（已加载 ${formatNumber(items.length)}）`}
          />
          <CardBody className="min-h-0 flex-1 overflow-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-900 text-[11px] uppercase tracking-wide text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-2 font-normal">组名</th>
                  <th className="px-4 py-2 font-normal">状态</th>
                  <th className="px-4 py-2 font-normal">成员</th>
                  <th className="px-4 py-2 font-normal">滞后</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((group) => {
                  const state = groupState(group.state);
                  return (
                    <tr
                      key={group.name}
                      className="border-b border-slate-800/60 last:border-0"
                    >
                      <td className="px-4 py-2 font-mono text-xs text-slate-200">
                        {group.name}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>
                      <td className="px-4 py-2 text-slate-400">
                        {formatNumber(group.members)}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={lagTone(group.totalLag)}>
                          {formatLag(group.totalLag)}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setSelected(group)}
                        >
                          查看详情
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {hasNextPage ? (
              <div className="flex justify-center p-3">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? "加载中…" : "加载更多"}
                </Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}

      {selected ? (
        <ConsumerGroupDialog
          connectionId={connectionId as string}
          group={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
