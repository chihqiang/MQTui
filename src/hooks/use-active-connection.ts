import { useParams } from "react-router";

import { useConnections } from "@/hooks/use-connections";
import type { ConnectionSummary } from "@/types";

/**
 * 当前连接，来源是 URL。
 *
 * 这里曾经读的是会话 store 里的 `activeConnectionId`，而那个字段只在
 * `/connections/:id` 这个索引路由里同步一次。从连接页直接点侧栏的「发送消息」
 * 进来时，`WorkspacePage` 根本没渲染过，store 还是 null —— 页面上明明连着、
 * 菜单里还高亮着当前连接，内容区却在说「先选一个连接」。
 *
 * URL 才是唯一说得清「我在哪条连接下」的地方：它跟着前进后退走，刷新也在，
 * 而 store 只是它的副本。副本就有落后的时候，那就不该让页面去读副本。
 */
export function useActiveConnection(): {
  connectionId: string | undefined;
  connection: ConnectionSummary | undefined;
} {
  const { connectionId } = useParams();
  const { data } = useConnections();
  return {
    connectionId,
    connection: data?.find((item) => item.id === connectionId),
  };
}
