/** 与 `src-tauri/src/domain/health.rs` 一一对应的领域类型。 */

/** 探测结论。`unknown` 表示未探测或不适用，不能当作可用。 */
export type CheckStatus = "ok" | "failed" | "unknown";

export interface HealthCheck {
  /** 稳定标识：`bootstrap` / `metadata` / `amqp` / `management` / `writeAccess`。 */
  key: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface HealthReport {
  items: HealthCheck[];
  /** 探测时间（毫秒时间戳）。 */
  checkedAt: number;
}

/** 写操作权限项的 key，与后端 `WRITE_ACCESS_KEY` 保持一致。 */
export const WRITE_ACCESS_KEY = "writeAccess";

/** 是否允许写操作：只有明确 `ok` 才算通过。 */
export function writeAllowed(report: HealthReport | undefined): boolean {
  return Boolean(
    report?.items.some((item) => item.key === WRITE_ACCESS_KEY && item.status === "ok"),
  );
}
