/** Kafka 主题运维接口，对应 `src-tauri/src/commands/topic.rs`。 */

import { call } from "./ipc";
import type {
  HotspotReport,
  PartitionExpansion,
  TopicCapabilities,
  TopicDetail,
  TopicOutcome,
  TopicSpec,
} from "@/types/topic";
import type { MigrationReport, MigrationRunbook, PlanCheck, VerifyResult } from "@/types/reassignment";
import type { ConfigChange, ConfigOutcome, ConfigPreview } from "@/types/topic-config";

export const topicService = {
  /** 主题详情：分区布局、副本同步、非默认配置项。 */
  getTopic: (id: string, topic: string) => call<TopicDetail>("get_topic", { id, topic }),

  /** 主题的运维能力（能不能删 / 扩容）及原因。 */
  getCapabilities: (id: string, topic: string) =>
    call<TopicCapabilities>("get_topic_capabilities", { id, topic }),

  createTopic: (id: string, spec: TopicSpec) => call<TopicOutcome>("create_topic", { id, spec }),

  /** 扩容分区。Kafka 只增不减，目标小于当前分区数会被后端拒绝。 */
  expandTopic: (id: string, expansion: PartitionExpansion) =>
    call<TopicOutcome>("expand_topic", { id, expansion }),

  deleteTopic: (id: string, topic: string, internal = false) =>
    call<TopicOutcome>("delete_topic", { id, topic, internal }),

  /**
   * 预览配置项修改：修改计划 + 版本体检。
   * 与提交共用后端同一个校验函数，避免预览归预览、提交另说。
   */
  previewConfigs: (id: string, topic: string, changes: ConfigChange[]) =>
    call<ConfigPreview>("preview_topic_configs", { id, topic, changes }),

  /**
   * 分区热点分析。必须显式给出主题清单：水位只能逐分区查询，
   * 全量扫描会让首屏卡住几十秒。
   */
  analyzeHotspots: (id: string, topics: string[]) =>
    call<HotspotReport>("analyze_partition_hotspots", { id, topics }),

  /**
   * 导出当前分区布局为一份重分配计划文本。
   * 这是迁移的起点：用户改副本分布后粘回来校验与跟踪。
   */
  exportReassignmentPlan: (id: string, topic: string) =>
    call<string>("export_reassignment_plan", { id, topic }),

  /** 校验一份重分配计划：结构、broker 是否存在、主题是否存在。 */
  checkReassignmentPlan: (id: string, topic: string, plan: string) =>
    call<PlanCheck>("check_reassignment_plan", { id, topic, plan }),

  /** 按计划报告迁移进度。 */
  getMigrationProgress: (id: string, topic: string, plan: string) =>
    call<MigrationReport>("get_migration_progress", { id, topic, plan }),

  /** 生成执行方案：脚本参数、前置检查、收尾动作。 */
  buildMigrationRunbook: (
    id: string,
    input: {
      topic: string;
      plan: string;
      throttle?: number;
      planFile?: string;
      minInsync?: number;
    },
  ) =>
    call<MigrationRunbook>("build_migration_runbook", {
      id,
      topic: input.topic,
      plan: input.plan,
      throttle: input.throttle ?? null,
      planFile: input.planFile ?? null,
      minInsync: input.minInsync ?? null,
    }),

  /** 解析 `--verify` 输出，并与元数据进度对齐。 */
  parseMigrationVerify: (id: string, topic: string, plan: string, output: string) =>
    call<VerifyResult>("parse_migration_verify", { id, topic, plan, output }),

  /** 提交配置项修改。走增量接口，未列出的配置项保持原样。 */
  updateConfigs: (id: string, topic: string, changes: ConfigChange[]) =>
    call<ConfigOutcome>("update_topic_configs", { id, topic, changes }),
};
