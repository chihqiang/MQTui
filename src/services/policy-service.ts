/** RabbitMQ 策略接口，对应 `src-tauri/src/commands/policy.rs`。 */

import { call } from "./ipc";
import type {
  PolicyInfo,
  PolicyPreview,
  PolicyRemovalPreview,
  PolicySnapshot,
  PolicySpec,
} from "@/types/policy";

export const policyService = {
  /** 全部策略（含操作员策略）。 */
  listPolicies: (id: string) => call<PolicySnapshot>("list_policies", { id }),

  getPolicy: (id: string, name: string) => call<PolicyInfo>("get_policy", { id, name }),

  /** 提交前预览：影响面、优先级冲突、注意事项。不写任何东西。 */
  previewPolicy: (id: string, spec: PolicySpec) =>
    call<PolicyPreview>("preview_policy", { id, spec }),

  /** 保存策略。`originalName` 非空表示重命名（先建新的、再删旧的）。 */
  savePolicy: (id: string, spec: PolicySpec, originalName?: string) =>
    call<PolicySnapshot>("save_policy", { id, spec, originalName: originalName ?? null }),

  /** 删除前的后果预检：哪些设置会退回默认、哪条策略会接手。只读。 */
  previewPolicyRemoval: (id: string, name: string) =>
    call<PolicyRemovalPreview>("preview_policy_removal", { id, name }),

  deletePolicy: (id: string, name: string) => call<PolicySnapshot>("delete_policy", { id, name }),
};
