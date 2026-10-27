import { useNavigate, useParams } from "react-router";

import { Button, Empty } from "@/components/ui";
import { useConnections } from "@/hooks/use-connections";
import { usePersistentWorkspace } from "@/hooks/use-persistent-workspace";
import { listSavedConnections } from "@/lib/session-storage";

import { OverviewPanel } from "@/components/broker/overview-panel";

/**
 * 工作区入口：渲染默认的能力页，并在连接已失效时给出重连出口。
 *
 * `App.tsx` 的子路由会命中更具体的路径；只有当路径停在
 * `/connections/:id` 时才会落到这里。
 */
export function WorkspacePage() {
  const { connectionId } = useParams();
  const navigate = useNavigate();
  const { data } = useConnections();
  usePersistentWorkspace();

  if (!connectionId) {
    return <Empty title="请选择一个连接" description="从左侧列表选择连接，或新建一个连接" />;
  }

  if (data && !data.some((item) => item.id === connectionId)) {
    // 连接 ID 是运行时生成的，重启后旧链接必然失效。此时给出一个明确的出口，
    // 而不是让用户自己回去找「新建连接」。
    const saved = listSavedConnections();
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Empty title="连接不存在" description="该连接可能已关闭或应用已重启" />
        <div className="flex gap-2">
          {saved.slice(0, 3).map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant="secondary"
              onClick={() => navigate({ pathname: "/", search: `?resume=${entry.id}` })}
            >
              重连 {entry.name}
            </Button>
          ))}
          <Button size="sm" onClick={() => navigate("/")}>
            返回连接页
          </Button>
        </div>
      </div>
    );
  }

  return <OverviewPanel />;
}
