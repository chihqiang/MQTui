import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rememberConnection, saveConnection } from "@/lib/session-storage";
import { brokerService, queryKeys } from "@/services";
import { useSessionStore } from "@/stores";
import type { ConnectionConfig } from "@/types";

/**
 * 已建立的连接列表。
 *
 * 这份数据被三处同时订阅：一级连接列表、二级菜单、命令面板。默认的 `staleTime`
 * 只有 10 秒，于是只要隔一会儿再点一下侧边栏，`useQuery` 就判定过期、重新拉一次，
 * `isLoading` 期间连接列表整块换成「加载中…」—— 列表在有数据的情况下消失再出现，
 * 是最典型的「不跟手」。连接的增删都由本文件的 mutation 显式失效，
 * 这里给一个长窗口即可：读的是本地状态，不存在过期的说法。
 */
export function useConnections() {
  return useQuery({
    queryKey: queryKeys.connections(),
    queryFn: brokerService.listConnections,
    staleTime: Infinity,
    // 切走再切回来不重新加载，侧边栏因此不会闪一下「加载中」。
    gcTime: Infinity,
  });
}

/** 建立连接的输入；`save` 为真时把完整配置（含密码）写入 localStorage。 */
export interface OpenConnectionInput {
  name: string;
  config: ConnectionConfig;
  save?: boolean;
}

/** 建立连接：成功后刷新列表、记住最近使用、并把错误交给 toast。 */
export function useOpenConnection() {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: OpenConnectionInput) =>
      brokerService.openConnection(input.name, input.config),
    onSuccess: (summary, input) => {
      rememberConnection({
        name: summary.name,
        kind: summary.kind,
        endpoint: summary.endpoint,
      });
      // 用户勾选「保存连接」时才落盘，密码随之进入 localStorage —— 由用户在界面上显式确认。
      if (input.save) {
        saveConnection(input.name, input.config);
      }
      pushToast("success", `已连接 ${input.name}`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
    },
    onError: (error: { message: string }) => pushToast("error", error.message),
  });
}

/** 关闭连接。 */
export function useCloseConnection() {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);
  const setActiveConnection = useSessionStore((state) => state.setActiveConnection);

  return useMutation({
    mutationFn: (id: string) => brokerService.closeConnection(id),
    onSuccess: (_data, id) => {
      if (useSessionStore.getState().activeConnectionId === id) {
        setActiveConnection(null);
      }
      pushToast("info", "连接已关闭");
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
    },
    onError: (error: { message: string }) => pushToast("error", error.message),
  });
}
