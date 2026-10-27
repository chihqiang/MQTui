/** 与 `src-tauri/src/error.rs` 中的 `AppError` 序列化结构一致。 */
export type AppErrorKind =
  | "invalid"
  | "connect"
  | "broker"
  | "not_found"
  | "unsupported"
  | "internal";

export interface AppErrorPayload {
  kind: AppErrorKind;
  message: string;
}

/** 统一的错误规整：Tauri 的 reject 值可能是对象、字符串或 Error。 */
export function toAppError(error: unknown): AppErrorPayload {
  if (isAppErrorPayload(error)) return error;
  if (error instanceof Error) {
    return { kind: "internal", message: error.message };
  }
  if (typeof error === "string") {
    return { kind: "internal", message: error };
  }
  return { kind: "internal", message: "未知错误" };
}

export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof (value as AppErrorPayload).message === "string"
  );
}

/** 面向用户的错误文案。 */
export function errorMessage(error: unknown): string {
  return toAppError(error).message;
}
