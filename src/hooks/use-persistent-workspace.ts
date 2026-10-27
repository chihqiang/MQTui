import { useEffect } from "react";
import { useParams } from "react-router";

import { useConnections } from "@/hooks/use-connections";
import { capabilityFromSegment } from "@/lib/nav";
import { saveWorkspace } from "@/lib/workspace-storage";

/**
 * 把当前路由位置写进 localStorage，重启后能回到原处。
 *
 * 只记录「kind + endpoint + 能力」这类稳定信息：连接的运行时 ID 重启后会变，
 * 恢复时需要重新建立连接再跳转。
 */
export function usePersistentWorkspace(): void {
  const { connectionId, "*": rest } = useParams();
  const { data } = useConnections();
  const connection = data?.find((item) => item.id === connectionId);

  useEffect(() => {
    if (!connection) return;
    saveWorkspace({
      connectionId: connection.id,
      kind: connection.kind,
      endpoint: connection.endpoint,
      capability: capabilityFromSegment(rest?.split("/")[0]),
    });
  }, [connection, rest]);
}
