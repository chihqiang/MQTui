import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { useListFilter } from "@/hooks/use-list-filter";

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Empty,
  ErrorState,
  SearchInput,
  SkeletonTable,
  TableActions,
  TableCell,
  TableRow,
  type DataTableColumn,
} from "@/components/ui";
import { useConsumerGroups } from "@/hooks/use-consumer-groups";
import { errorMessage } from "@/lib/errors";
import { formatLag, groupState, lagTone } from "@/lib/consumer";
import { formatNumber } from "@/lib/format";
import type { ConsumerGroupInfo } from "@/types";

import { ConsumerGroupDialog } from "@/pages/kafka/consumer-group-detail";

const GROUP_COLUMNS: DataTableColumn[] = [
  { key: "name", label: "组名" },
  { key: "state", label: "状态", width: "w-28" },
  { key: "members", label: "成员", width: "w-20", align: "right" },
  { key: "lag", label: "滞后", width: "w-28", align: "right" },
  { key: "actions", label: <span className="sr-only">操作</span>, width: "w-20", align: "right" },
];

/**
 * Kafka 消费组列表。
 *
 * 列表页只展示「组名 / 状态 / 成员数」，滞后量要逐分区查水位，
 * 代价与组数成正比，因此留给详情页按需计算 —— 打开一眼就能看懂，
 * 又不会因为集群里有几百个组而拖慢首屏。
 */
export function ConsumerGroupsPage() {
  const { connectionId } = useParams();
  // 过滤词存 URL：点进详情再返回时，刚打的字还在。
  const [keyword, setKeyword] = useListFilter();
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

  // 摊平结果做 memo：`useInfiniteQuery` 的 `data` 只在翻页时变，
  // 但组件每次重渲染都会新造一个数组 —— 下面的表格因此每帧都拿到新 props。
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return (
    <div className="flex h-full flex-col p-4">
      <form
        className="mb-3 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setKeyword(draft.trim());
        }}
      >
        <div className="w-72">
          <SearchInput
            value={draft}
            onValueChange={setDraft}
            placeholder="按组名过滤（不区分大小写）"
            aria-label="消费组关键字"
          />
        </div>
        <Button type="submit" size="sm">
          过滤
        </Button>
        {keyword ? (
          <Button
            type="button"
            size="sm"
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
        <Card>
          <SkeletonTable rows={8} />
        </Card>
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
            <DataTable
              columns={GROUP_COLUMNS}
              className="text-sm"
              stickyHeader
              scrollable={false}
            >
              {items.map((group) => {
                const state = groupState(group.state);
                return (
                  <TableRow key={group.name} clickable onClick={() => setSelected(group)}>
                    <TableCell mono className="text-slate-800">
                      {group.name}
                    </TableCell>
                    <TableCell>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </TableCell>
                    <TableCell muted numeric>
                      {formatNumber(group.members)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={lagTone(group.totalLag)}>{formatLag(group.totalLag)}</Badge>
                    </TableCell>
                    <TableCell align="right">
                      <TableActions>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(event) => {
                            // 整行可点，按钮内的点击不该冒泡成第二次打开。
                            event.stopPropagation();
                            setSelected(group);
                          }}
                        >
                          详情
                        </Button>
                      </TableActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </DataTable>
            {hasNextPage ? (
              <div className="flex justify-center p-3">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  加载更多
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
