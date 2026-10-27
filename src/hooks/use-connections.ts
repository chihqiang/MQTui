import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { connectFailureLine } from "@/lib/connect-failure";
import { toAppError } from "@/lib/errors";
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
    onError: (error, input) => {
      const payload = toAppError(error);
      // 失败时不在 toast 里念后端原文：连不上的时候人要听的是「该改哪一处」。
      // 完整的错误仍然留在向导里（`ConnectWizard` 的表单上方），可展开看原文。
      pushToast("error", connectFailureLine(payload, endpointOf(input)));
    },
  });
}

/** 错误摘要里用来指认「连的是哪儿」的那一段地址。 */
function endpointOf(input: OpenConnectionInput): string {
  const config = input.config;
  return config.kind === "kafka" ? config.brokers.join(", ") : `${config.host}:${config.port}`;
}

/**
 * 断开一条连接。
 *
 * 断开的语义是「后端句柄关掉、界面不再指向它」，所以三件事一起做：
 * 清掉当前选中、把这条连接的所有缓存作废、把人送回连接页。
 *
 * 最后一件最容易漏：留在原页面时，概览 / 主题 / 队列的查询会立刻因为
 * 「连接不存在」全部变成红色错误态 —— 用户点的是「断开」，看到的却是
 * 满页报错。断开不是故障，界面不该用故障的样子回报它。
 */
export function useCloseConnection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pushToast = useSessionStore((state) => state.pushToast);
  const setActiveConnection = useSessionStore((state) => state.setActiveConnection);

  return useMutation({
    mutationFn: (id: string) => brokerService.closeConnection(id),
    onSuccess: async (_data, id) => {
      if (useSessionStore.getState().activeConnectionId === id) {
        setActiveConnection(null);
      }
      // 连接级查询挂在 `["connections","detail",id,...]` 下：整棵子树一起丢掉，
      // 下次连上同一台机器时读到的必须是新数据，而不是断开前那份快照。
      await queryClient.cancelQueries({ queryKey: queryKeys.connection(id) });
      queryClient.removeQueries({ queryKey: queryKeys.connection(id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections() });
      pushToast("info", "连接已断开");
      navigate("/");
    },
    onError: (error: { message: string }) => pushToast("error", error.message),
  });
}
