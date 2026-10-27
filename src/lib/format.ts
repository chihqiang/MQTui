/** 展示层的统一格式化工具。 */

const numberFormatter = new Intl.NumberFormat("zh-CN");

/** 数字千分位。 */
export function formatNumber(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "-";
  return numberFormatter.format(value);
}

/** 毫秒时间戳格式化为本地时间。 */
export function formatTimestamp(value: number | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 字节数转为可读单位。 */
export function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
