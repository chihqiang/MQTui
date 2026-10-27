import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "@/lib/errors";
import { queryKeys, topicService } from "@/services";
import { useSessionStore } from "@/stores";
import type { ConfigChange, PartitionExpansion, TopicSpec } from "@/types";

/** 主题详情。点开详情才请求，列表阶段不背这部分体积。 */
export function useTopicDetail(connectionId: string | undefined, topic: string | undefined) {
  return useQuery({
    queryKey: queryKeys.topic(connectionId ?? "", topic ?? ""),
    queryFn: () => topicService.getTopic(connectionId as string, topic as string),
    enabled: Boolean(connectionId && topic),
  });
}

/**
 * 主题运维能力。规则在后端 `TopicRemoval` / `TopicCapabilities` 里，
 * 前端只负责照着渲染，避免两边各写一套判断后慢慢漂移。
 */
export function useTopicCapabilities(
  connectionId: string | undefined,
  topic: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.topicCapabilities(connectionId ?? "", topic ?? ""),
    queryFn: () => topicService.getCapabilities(connectionId as string, topic as string),
    enabled: Boolean(connectionId && topic),
    // 能力只随主题属性变化，切页面回来不必重算。
    staleTime: 30_000,
  });
}

/**
 * 写操作的公共收尾：成功提示 + 让连接相关的缓存全部失效。
 *
 * 主题的增删会同时影响主题列表、分区明细、无消费组扫描的候选集，
 * 逐个失效容易漏，统一走 `allConnections` 前缀。
 */
function useTopicMutation<TInput>(
  mutate: (input: TInput) => Promise<unknown>,
  successMessage: (input: TInput) => string,
) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: mutate,
    onSuccess: (_data, input) => {
      pushToast("success", successMessage(input));
      void queryClient.invalidateQueries({ queryKey: queryKeys.allConnections() });
    },
    // 错误统一走 toast：扩容到非法分区数、删内部主题这类拒绝不该占满整页。
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 新建主题。 */
export function useCreateTopic(connectionId: string | undefined) {
  return useTopicMutation(
    (spec: TopicSpec) => topicService.createTopic(connectionId as string, spec),
    (spec) => `已创建主题 ${spec.name.trim()}`,
  );
}

/** 扩容分区。 */
export function useExpandTopic(connectionId: string | undefined) {
  return useTopicMutation(
    (expansion: PartitionExpansion) =>
      topicService.expandTopic(connectionId as string, expansion),
    (expansion) => `${expansion.topic} 已扩容到 ${expansion.partitions} 个分区`,
  );
}

/** 删除主题。 */
export function useDeleteTopic(connectionId: string | undefined) {
  return useTopicMutation(
    (input: { topic: string; internal: boolean }) =>
      topicService.deleteTopic(connectionId as string, input.topic, input.internal),
    (input) => `已删除主题 ${input.topic}`,
  );
}

/**
 * 提交配置项修改。
 *
 * 不走 `useTopicMutation` 的 `allConnections` 全量失效：改配置只影响这个主题的
 * 详情页，全量失效会让其它页面的数据在后台重拉一遍，代价没必要。
 */
export function useUpdateTopicConfigs(connectionId: string | undefined, topic: string) {
  const queryClient = useQueryClient();
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (changes: ConfigChange[]) =>
      topicService.updateConfigs(connectionId as string, topic, changes),
    onSuccess: (outcome) => {
      if (outcome.applied.length === 0) {
        // 用户点了保存但什么都没改 —— 这是个合法结果，不该谎报「已修改」。
        pushToast("info", outcome.detail);
        return;
      }
      pushToast("success", `${outcome.topic} 已修改 ${outcome.applied.length} 项配置`);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.topic(connectionId ?? "", topic),
      });
    },
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 预览配置项修改。只在点「保存」时触发，不做边输边算。 */
export function usePreviewTopicConfigs(connectionId: string | undefined, topic: string) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (changes: ConfigChange[]) =>
      topicService.previewConfigs(connectionId as string, topic, changes),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/**
 * 分区热点分析。
 *
 * 用 mutation 而不是 query：结果只在用户点「分析」之后才该出现，
 * 而且分析范围是勾选出来的主题集合，不是 URL 里的固定参数。
 */
export function useAnalyzeHotspots(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (topics: string[]) => topicService.analyzeHotspots(connectionId as string, topics),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/**
 * 主题吞吐采样。
 *
 * 用 mutation 而不是 query：每次调用都要真等满一个窗口（默认 5 秒），
 * 自动重取会让页面在后台一直挂着请求。这是「用户点一下，等一会儿，看一个数」。
 */
export function useTopicThroughput(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: { topic: string; windowMs: number }) =>
      topicService.sampleThroughput(connectionId as string, input.topic, input.windowMs),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/**
 * 导出重分配计划。
 *
 * 用 mutation 而不是 query：导出的结果是「这一刻的布局快照」，用户把它拿去改，
 * 缓存一份旧快照只会让「再点一次导出」拿不到最新值。
 */
export function useExportReassignmentPlan(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (topic: string) =>
      topicService.exportReassignmentPlan(connectionId as string, topic),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 校验重分配计划：结构、broker 是否存在、主题是否存在。 */
export function useCheckReassignmentPlan(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: { topic: string; plan: string }) =>
      topicService.checkReassignmentPlan(connectionId as string, input.topic, input.plan),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 按计划报告迁移进度。只在用户点「检查进度」时跑，不做轮询。 */
/** 生成迁移执行方案。参数里有多个可选项，所以按对象传。 */
export function useMigrationRunbook(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: {
      topic: string;
      plan: string;
      throttle?: number;
      planFile?: string;
      minInsync?: number;
    }) => topicService.buildMigrationRunbook(connectionId as string, input),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

/** 解析 `--verify` 输出。 */
export function useParseMigrationVerify(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: { topic: string; plan: string; output: string }) =>
      topicService.parseMigrationVerify(
        connectionId as string,
        input.topic,
        input.plan,
        input.output,
      ),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}

export function useMigrationProgress(connectionId: string | undefined) {
  const pushToast = useSessionStore((state) => state.pushToast);

  return useMutation({
    mutationFn: (input: { topic: string; plan: string }) =>
      topicService.getMigrationProgress(connectionId as string, input.topic, input.plan),
    onError: (error) => pushToast("error", errorMessage(error)),
  });
}
