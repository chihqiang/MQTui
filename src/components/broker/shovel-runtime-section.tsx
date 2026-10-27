
import { Badge, Card, CardBody, CardHeader, Empty, RefreshButton, StaleNotice } from "@/components/ui";
import { useShovels } from "@/hooks/use-shovels";
import { errorMessage } from "@/lib/errors";
import { failureText } from "@/lib/failure";
import {
  attentionCount,
  needsAttention,
  stateLabel,
  stateTone,
  stopHint,
  summarize,
  transferredText,
} from "@/lib/shovel";
import type { ShovelRow, ShovelSnapshot } from "@/types/shovel";

/**
 * 铲子运行态。
 *
 * 参数页那半张表说的是「打算搬」（一段 JSON），这块说的是「正在搬」。
 * 两者必须并排看，理由很直接：配置看起来完全正常、消息却一点不动的四种情况
 * （插件没启用、地址连不上、进程已退出、名字只差一个前缀）在参数里长得一模一样，
 * 只有运行态能分开它们。
 *
 * 这里**没有启停按钮**。管理 API 没有 stop 端点，唯一的写操作是删运行态，
 * 而它删掉静态铲子后「下次重启会照配置再起来」—— 给个按钮再附一段免责声明，
 * 比不给更糟。要停就改配置，那件事在下面那张表里。
 */
export function ShovelRuntimeSection({ connectionId }: { connectionId: string }) {
  // 不过滤：这张表本来就短，而「所有铲子」正是它要回答的问题 ——
  // 加个搜索框反而会让人以为筛过的结果就是全部。
  const { data, isLoading, error, refetch } = useShovels(connectionId);

  return (
    <Card>
      <CardHeader
        title="铲子运行态"
        extra={
          <span className="flex items-center gap-2">
            {data ? (
              <Badge tone={attentionCount(data) > 0 ? "warning" : "neutral"}>
                {summarize(data)}
              </Badge>
            ) : null}
            <RefreshButton
              state={{
                firstLoad: !data,
                refreshing: isLoading,
                hasData: Boolean(data),
              }}
              onRefresh={() => void refetch()}
            />
          </span>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-(length:--text-app-meta) text-slate-500">
          下面这张表来自 `/api/shovels`，是**此刻**的状态；上面那张表是配置。
          配置正常但这里没有对应行，说明它根本没被加载。
        </p>

        {error && data ? (
          <StaleNotice
            message={failureText("刷新运行态", errorMessage(error))}
            onRetry={() => void refetch()}
          >
            下面是上一次读到的结果
          </StaleNotice>
        ) : null}
        {error && !data ? (
          <p className="text-(length:--text-app-body) text-rose-700">
            {failureText("读取运行态", errorMessage(error))}
          </p>
        ) : null}

        {data ? <RuntimeBody snapshot={data} /> : null}
      </CardBody>
    </Card>
  );
}

function RuntimeBody({ snapshot }: { snapshot: ShovelSnapshot }) {
  // 运行态读不到时，半张表比没有更危险：它会让人以为「一条都没在跑」。
  const blind = snapshot.runtimeError ? (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-(length:--text-app-body) text-amber-800">
      读不到运行态：{snapshot.runtimeError}
      <span className="text-amber-700">
        {" "}
        —— 通常是 shovel 插件未启用或当前账号没有权限。下面每一行的「无运行态」都只表示
        「看不到」，不表示「没在跑」。
      </span>
    </p>
  ) : null;

  if (!snapshot.rows.length) {
    return (
      <>
        {blind}
        <Empty
          title={snapshot.runtimeError ? "运行态不可用" : "没有铲子"}
          description={
            snapshot.runtimeError
              ? undefined
              : "铲子是「把消息从一个地址搬到另一个地址」，在上面新建一条 shovel 参数后这里才会出现它的运行态"
          }
        />
      </>
    );
  }

  return (
    <>
      {blind}
      <ul className="divide-y divide-slate-200 rounded border border-slate-200">
        {snapshot.rows.map((row) => (
          <RuntimeRow key={`${row.vhost}#${row.name}`} row={row} />
        ))}
      </ul>
    </>
  );
}

function RuntimeRow({ row }: { row: ShovelRow }) {
  const runtime = row.runtime;

  return (
    <li className="flex flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-(length:--text-app-body) text-slate-800">{row.name}</span>
        <Badge tone={stateTone(row)}>{stateLabel(row)}</Badge>
        {row.foreign ? <Badge tone="neutral">{row.vhost}</Badge> : null}
        <span className="text-(length:--text-app-meta) text-slate-500">
          已搬 {transferredText(row)}
        </span>
        {runtime && needsAttention(row) && !row.problem && runtime.reason.trim() ? (
          <span className="text-(length:--text-app-meta) text-rose-700">{runtime.reason}</span>
        ) : null}
      </div>

      {runtime?.srcUri ? (
        <p className="font-mono text-(length:--text-app-meta) text-slate-500">
          {runtime.srcUri} → {runtime.destUri || "?"}
        </p>
      ) : null}

      {row.problem ? (
        <p className="text-(length:--text-app-meta) text-amber-700">{row.problem}</p>
      ) : null}

      {/* 「停了」是一个要动手的事，说清怎么停、停完会发生什么。 */}
      {runtime && runtime.state !== "running" ? (
        <p className="text-(length:--text-app-meta) text-slate-500">{stopHint(row)}</p>
      ) : null}
    </li>
  );
}
