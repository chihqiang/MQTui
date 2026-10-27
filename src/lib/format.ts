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

/**
 * 字节数转为可读单位。
 *
 * 单位表要一直排到 TB：磁盘余量是这块的常客，只排到 GB 时一个 2 TB 的盘
 * 会显示成 `2048.0 GB` —— 数字对，但读的人得自己在脑子里再换一次单位。
 *
 * 负数与 `NaN` 返回 `-`：管理 API 在某些节点上会给出负的余量（水位计算口径不同），
 * 显示成「-1.0 B 可用」比「-」更容易被当真。
 */
export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
