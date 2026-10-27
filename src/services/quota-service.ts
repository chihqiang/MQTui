/** Kafka 准入类接口，对应 `src-tauri/src/commands/quota.rs`。 */

import { call } from "./ipc";
import type { QuotaSnapshot, ScramSnapshot } from "@/types/quota";

export const quotaService = {
  /** 客户端配额：配额本身 + broker 级默认值（后者在 `notes` 里）。 */
  describeClientQuotas: (id: string) => call<QuotaSnapshot>("describe_client_quotas", { id }),

  /**
   * 全部用户的 SASL/SCRAM 凭据。
   *
   * broker 低于 2.7.0 时返回 `unsupported`，不是错误 —— 「问不了」是这一屏的正常状态。
   */
  describeUserScramCredentials: (id: string) =>
    call<ScramSnapshot>("describe_user_scram_credentials", { id }),
};
