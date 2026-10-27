type ClassValue = string | false | null | undefined;

/** 轻量的 className 拼接，避免为几个类名引入 clsx。 */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
