import { Badge, Callout } from "@/components/ui";
import { IconRefresh } from "@/lib/icons";
import { emptyRouteHint } from "@/lib/produce";
import type { SendRoute } from "@/types/message";

/**
 * 发送预览：这条消息会落到哪些队列。
 *
 * 放在发送按钮旁边而不是弹窗里 —— 它的作用是「发之前看一眼」，
 * 需要点开才看得见的东西，没人会点。
 *
 * 四种状态说的话完全不同，混在一起就等于什么都没说：
 * - 算出来了：列出队列名，顺带标出经过交换机间转发才到的那几个；
 * - 算出来是空的：这是唯一「发出去等于丢」的情形，必须显眼；
 * - 数据不全（`bindingsKnown` 为假）：空的队列列表只代表「查不到」，
 *   不能顺着说「没人收得到」—— 那会让人去改一条本来没问题的消息；
 * - 算不出来（管理 API 不可用）：照实说明，不装作「没人收得到」。
 */
export function SendRoutePreview({
  route,
  error,
  pending,
  onRefresh,
}: {
  route: SendRoute | null;
  /** 预览失败的原因（多为没配管理 API）。 */
  error: string | null;
  pending: boolean;
  onRefresh: () => void;
}) {
  if (error) {
    return (
      <Callout tone="info">
        路由预览不可用：{error}
        <button
          type="button"
          className="ml-2 text-indigo-600 underline-offset-2 hover:underline"
          onClick={onRefresh}
        >
          重试
        </button>
      </Callout>
    );
  }

  if (!route) {
    return (
      <p className="text-(length:--text-app-meta) text-slate-500">
        {pending ? "正在算这条消息会投到哪些队列…" : "还没有可预览的路由。"}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-(length:--text-app-meta) text-slate-500">
          {route.bindingsKnown === false
            ? "无法确认这条消息会投到哪些队列"
            : `这条消息会投到 ${route.queues.length} 个队列`}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={onRefresh}
          className="flex items-center gap-1 text-(length:--text-app-meta) text-slate-500 transition-colors hover:text-slate-700 disabled:opacity-50"
        >
          <IconRefresh size={12} />
          {pending ? "计算中" : "重算"}
        </button>
      </div>

      {route.warning ? <Callout tone="warning">{route.warning}</Callout> : null}

      {/* 空列表本身不显眼，却最容易被误读，所以两种含义都单独说一句。 */}
      {route.queues.length === 0 ? (
        <Callout tone={route.bindingsKnown === false ? "info" : "danger"}>
          {emptyRouteHint(route)}
        </Callout>
      ) : null}

      {route.queues.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {route.queues.map((item) => (
            <li
              key={item.queue}
              className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-(length:--text-app-body) text-slate-800">
                {item.queue}
              </span>
              {item.viaExchange ? <Badge tone="neutral">经交换机转发</Badge> : null}
              {item.routingKey ? (
                <span className="shrink-0 font-mono text-(length:--text-app-meta) text-slate-500">
                  {item.routingKey}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
