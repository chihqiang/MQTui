import { NavLink, useParams } from "react-router";

import { useCloseConnection, useConnections } from "@/hooks/use-connections";
import { IconServer } from "@/lib/icons";
import { NEW_CONNECTION_PATH } from "@/lib/nav";

import { ConnectionNode } from "./connection-node";

/**
 * 侧栏：一列到底，两层就是全部层级。
 *
 * ```
 * 连接                                 标题 + 新建
 *   kafka-prod  10.0.1.12:9092         第一层：一条连接，点名字就是进工作区
 *     概览 / 主题 / 消费组 …           第二层：这条连接的页面，点了就换页
 *   kafka-test  10.0.1.30:9092
 *     概览 / 主题 / 消费组 …
 * ```
 *
 * 两层，没有第一层的分类：
 *
 * - **中间件分组不再是侧栏的一层**。Kafka / RabbitMQ 的区别已经画在每条
 *   连接行首的徽标上（形状 + 身份色），再罩一个分组标题，等于每次进侧栏
 *   先看一层「这是哪家」，而它并不回答「我要去哪」。连接按后端给的原顺序
 *   一条条排下去，最近连上的自然在最前面。
 * - **折叠只做在连接上**，收起的是这台机器的页面菜单，不是「这一家的连接」：
 *   收起分类会连带藏掉别台的入口，收起单条只影响它自己。当前所在的连接
 *   不参与折叠 —— 站在里面却看不见菜单，等于把路标收进抽屉。
 *
 * 身份色只出现在连接行左侧的徽标上：Kafka / RabbitMQ 的徽标若跟「选中态」
 * （靛蓝）抢同一个行高，就看不出哪个是「我现在在哪」。
 */
export function Sidebar() {
  const { connectionId } = useParams();
  const { data, isLoading } = useConnections();
  const closeConnection = useCloseConnection();

  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-10 shrink-0 items-center justify-between px-3.5 pt-1">
        <p className="text-(length:--text-app-micro) font-semibold tracking-wider text-secondary uppercase">
          连接
        </p>
        <NavLink
          to={NEW_CONNECTION_PATH}
          title="新建连接"
          aria-label="新建连接"
          className="flex size-6 items-center justify-center rounded-md text-meta transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <IconServer size={12} />
        </NavLink>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pt-1 pb-4">
        {isLoading ? (
          <p className="px-2 text-(length:--text-app-meta) text-meta">加载中…</p>
        ) : null}
        {data?.length === 0 ? (
          <p className="px-2 text-(length:--text-app-meta) leading-relaxed text-meta">
            还没有连接。点上面的 <IconServer size={11} className="inline align-[-1px]" /> 新建一条。
          </p>
        ) : null}

        {data?.map((connection) => (
          <ConnectionNode
            key={connection.id}
            connection={connection}
            active={connectionId === connection.id}
            onDisconnect={() => closeConnection.mutate(connection.id)}
            disconnecting={closeConnection.isPending}
          />
        ))}
      </nav>
    </aside>
  );
}
